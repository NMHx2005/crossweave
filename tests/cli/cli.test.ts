import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { $ } from 'bun';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeGitFixture, type GitFixture } from '../helpers/git-fixture.js';

const CLI = fileURLToPath(new URL('../../src/cli/index.ts', import.meta.url));
let fx: GitFixture;

interface CwResult { exitCode: number; stdout: string; stderr: string }

async function run(cwd: string, args: string[]): Promise<CwResult> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, stdout, stderr };
}

function cw(args: string[]): Promise<CwResult> {
  return run(fx.root, args);
}

beforeEach(async () => { fx = await makeGitFixture(); });
afterEach(async () => {
  await cw(['daemon', 'stop']);
  await fx.cleanup();
});

describe('cw CLI', () => {
  it('init creates the workspace and prints its name', async () => {
    const r = await cw(['init']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(fx.root.split('/').pop()!);
    expect(existsSync(join(fx.root, '.crossweave', 'state.db'))).toBe(true);
  }, 30_000);

  it('runs the full session lifecycle', async () => {
    await cw(['init']);

    const created = await cw(['session', 'new', '--name', 'auth', '--agent', 'claude']);
    expect(created.exitCode).toBe(0);
    expect(created.stdout).toContain('auth');
    expect(existsSync(join(fx.root, '.crossweave', 'worktrees'))).toBe(true);

    const listed = await cw(['session', 'list']);
    expect(listed.stdout).toContain('auth');
    expect(listed.stdout).toContain('idle');
    expect(listed.stdout).toContain('T3');

    const renamed = await cw(['session', 'rename', 'auth', 'auth2']);
    expect(renamed.exitCode).toBe(0);
    expect((await cw(['session', 'list'])).stdout).toContain('auth2');

    const killed = await cw(['session', 'kill', 'auth2', '--rm-worktree', '--yes']);
    expect(killed.exitCode).toBe(0);
    // --rm-worktree means the work is gone, so the row is deleted, not left dead —
    // that is what makes the name reusable again.
    expect((await cw(['session', 'list'])).stdout).toContain('no sessions');
  }, 60_000);

  it('exits non-zero with the error code on a bad session name', async () => {
    await cw(['init']);
    const r = await cw(['session', 'kill', 'ghost', '--yes']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('SESSION_NOT_FOUND');
  }, 30_000);

  it('refuses --rm-worktree without --yes, in the same CODE: format as every other error', async () => {
    await cw(['init']);
    await cw(['session', 'new', '--name', 'guarded', '--agent', 'claude']);
    const r = await cw(['session', 'kill', 'guarded', '--rm-worktree']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('CONFIRMATION_REQUIRED:');
    // The session must still be alive — a refused command changes nothing.
    expect((await cw(['session', 'list'])).stdout).toContain('guarded');
  }, 60_000);

  it('rejects an invalid session name on exactly one stderr line', async () => {
    await cw(['init']);
    const r = await cw(['session', 'new', '--name', 'bad name', '--agent', 'claude']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('INVALID_SESSION_NAME:');
    // The contract the TUI parses: every stderr line carries a CODE: prefix.
    const lines = r.stderr.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
  }, 30_000);

  it('session rm frees the name, and refuses without --yes', async () => {
    await cw(['init']);
    await cw(['session', 'new', '--name', 'gone', '--agent', 'claude']);
    await cw(['session', 'kill', 'gone', '--yes']);

    const refused = await cw(['session', 'rm', 'gone']);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain('CONFIRMATION_REQUIRED:');
    expect((await cw(['session', 'list'])).stdout).toContain('gone');

    const removed = await cw(['session', 'rm', 'gone', '--yes']);
    expect(removed.exitCode).toBe(0);
    expect((await cw(['session', 'list'])).stdout).toContain('no sessions');

    const recreated = await cw(['session', 'new', '--name', 'gone', '--agent', 'claude']);
    expect(recreated.exitCode).toBe(0);
  }, 60_000);

  it('daemon stop reports success without starting a daemon when none is running', async () => {
    const r = await cw(['daemon', 'stop']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('no daemon running');
    // And it must not have spawned one on the way out.
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(fx.root, '.crossweave', 'daemon.sock'))).toBe(false);
  }, 30_000);

  // Regression, and it MUST drive the real CLI through a pty. The wire-level
  // scrollback test in tests/daemon/runtime.test.ts passes even with attach.ts's fix
  // reverted, because it never calls into attach.ts — the defect was purely the order
  // of registration inside the CLI, and only a test that runs the CLI can see it.
  it('replays scrollback when re-attaching to a live session', async () => {
    const { mkdtemp, rm, writeFile, chmod } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const binDir = await mkdtemp(join(tmpdir(), 'cw-fakebin-'));
    try {
      const fake = join(binDir, 'claude');
      await writeFile(fake, '#!/bin/sh\necho MARKER_XYZ\nwhile IFS= read -r l; do echo "got:$l"; done\n');
      await chmod(fake, 0o755);
      const env = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` };

      // The daemon is spawned lazily by whichever `cw` invocation needs it first, and
      // it inherits THAT process's env — not the env of whatever `cw` call happens to
      // attach later. The fake `claude` has to be on PATH before the daemon starts, or
      // the agent it spawns is the real one on the machine.
      const cwFake = async (args: string[]): Promise<CwResult> => {
        const proc = Bun.spawn([process.execPath, CLI, ...args], {
          cwd: fx.root, env, stdout: 'pipe', stderr: 'pipe',
        });
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        return { exitCode: await proc.exited, stdout, stderr };
      };

      await cwFake(['init']);
      await cwFake(['session', 'new', '--name', 'replay', '--agent', 'claude']);

      const attachOnce = async (): Promise<string> => {
        let out = '';
        const proc = Bun.spawn([process.execPath, CLI, 'session', 'attach', 'replay'], {
          cwd: fx.root,
          env,
          terminal: {
            cols: 80,
            rows: 24,
            data(_t: unknown, chunk: string | Uint8Array) {
              out += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
            },
          },
        }) as unknown as { terminal: { write(s: string): void }; exited: Promise<number> };

        await Bun.sleep(1500);
        proc.terminal.write('\x1d'); // Ctrl-] detaches
        await proc.exited;
        return out;
      };

      const first = await attachOnce();
      expect(first).toContain('MARKER_XYZ');

      // The session is still running. Re-attaching must replay what it already printed.
      const second = await attachOnce();
      expect(second).toContain('MARKER_XYZ');

      await cwFake(['session', 'kill', 'replay', '--yes']);
    } finally {
      await rm(binDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('attach reports a clear error for an unknown session', async () => {
    await cw(['init']);
    const r = await cw(['session', 'attach', 'ghost']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('SESSION_NOT_FOUND');
  }, 30_000);

  it('exits non-zero outside a git repository', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const bare = await mkdtemp(join(tmpdir(), 'cw-nogit-'));
    try {
      const r = await run(bare, ['init']);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('NOT_A_REPO');
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  }, 30_000);

  // Integration-level check of the overall contract (one line, CODE: prefix, no
  // trailing space) against a genuinely multi-line wrapped subprocess error.
  //
  // Deleting `.crossweave/worktrees` outright (the original repro) does not make
  // `git worktree remove --force` fail on git 2.50.1: it treats an already-gone
  // directory as nothing to prune and exits 0. Locking the worktree does reproduce a
  // real failure — a single --force cannot override a lock, and git's fatal message
  // for that is genuinely two lines.
  //
  // This does NOT guard fail()'s \r-handling specifically: git never emits a bare \r
  // here (only \n), and it sanitizes \r out of a lock's --reason field too — see
  // tests/cli/context.test.ts for the direct unit test that actually catches that.
  it('collapses a wrapped multi-line error into one clean line', async () => {
    await cw(['init']);
    const created = await cw(['session', 'new', '--name', 'crlf', '--agent', 'claude']);
    const worktreePath = created.stdout.trim().split('\t')[3]!;
    await $`git worktree lock ${worktreePath} --reason locked-for-test`.cwd(fx.root).quiet();

    const r = await cw(['session', 'kill', 'crlf', '--rm-worktree', '--yes']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.endsWith('\n')).toBe(true);
    // Strip exactly the one trailing '\n' the write template always appends — not
    // trimEnd(), which would silently swallow a genuine trailing-space regression.
    const body = r.stderr.slice(0, -1);
    expect(body.split('\n')).toHaveLength(1);
    expect(body).toMatch(/^[A-Z_]+: /);
    expect(body).not.toContain('\r');
    expect(body).not.toMatch(/\s$/);
  }, 60_000);

  it('session stop leaves the session idle and resumable', async () => {
    await cw(['init']);
    await cw(['session', 'new', '--name', 'pausable', '--agent', 'claude']);

    const help = await cw(['session', '--help']);
    expect(help.stdout).toContain('stop');

    const stopped = await cw(['session', 'stop', 'pausable']);
    expect(stopped.exitCode).toBe(0);
    expect((await cw(['session', 'list'])).stdout).toContain('idle');

    // And it is a real command, not a stub: an unknown target fails in the standard shape.
    const missing = await cw(['session', 'stop', 'ghost']);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('SESSION_NOT_FOUND:');
  }, 60_000);

  it('a missing required argument reports in the standard shape', async () => {
    await cw(['init']);
    const r = await cw(['session', 'stop']);
    expect(r.exitCode).toBe(1);
    const lines = r.stderr.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^[A-Z_]+: /);
  }, 30_000);

  it('gc reclaims ended sessions and reports nothing when there are none', async () => {
    await cw(['init']);
    expect((await cw(['gc'])).stdout).toContain('nothing to reclaim');

    await cw(['session', 'new', '--name', 'trash', '--agent', 'claude']);
    await cw(['session', 'kill', 'trash', '--yes']);

    const r = await cw(['gc']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('trash');
    expect((await cw(['session', 'list'])).stdout).toContain('no sessions');
  }, 60_000);

  /**
   * The DoD requires each of these to reach the user as exactly one `CODE: message`
   * line. Every one of them was previously only asserted at its throw site, which
   * proves the error exists — not that it survives the RPC -> CLI -> fail() path. It
   * did not for CONFIG_INVALID: `loadConfig` ran inside the DETACHED daemon, whose
   * stdio is 'ignore', so the throw killed the daemon before it bound its socket and
   * the CLI reported a 10-second DAEMON_START_FAILED instead.
   */
  describe('error codes reaching stderr end to end', () => {
    function expectOneCodeLine(r: CwResult, code: string): void {
      expect(r.exitCode).toBe(1);
      const lines = r.stderr.trimEnd().split('\n');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toStartWith(`${code}: `);
    }

    it('CONFIG_INVALID from a malformed crossweave.config.json', async () => {
      await writeFile(join(fx.root, 'crossweave.config.json'), '{ not json');
      const r = await cw(['init']);
      expectOneCodeLine(r, 'CONFIG_INVALID');
      expect(r.stderr).not.toContain('DAEMON_START_FAILED');
    }, 30_000);

    it('CONFIG_INVALID from a ports.named key that would clobber PATH', async () => {
      await writeFile(
        join(fx.root, 'crossweave.config.json'),
        JSON.stringify({ ports: { named: { PATH: 0 } } }),
      );
      const r = await cw(['init']);
      expectOneCodeLine(r, 'CONFIG_INVALID');
      expect(r.stderr).toContain('PATH');
    }, 30_000);

    it('NO_PORTS_AVAILABLE when the only block in range is held by another process', async () => {
      // A range with room for exactly one block, so a single squatter exhausts it.
      const base = 65020;
      await writeFile(
        join(fx.root, 'crossweave.config.json'),
        JSON.stringify({ ports: { base, blockSize: 500 } }),
      );
      await cw(['init']);
      await cw(['session', 'new', '--name', 'portless', '--agent', 'claude']);

      const squatter = createServer();
      await new Promise<void>((resolve, reject) => {
        squatter.once('error', reject);
        squatter.listen(base, '127.0.0.1', () => resolve());
      });
      try {
        expectOneCodeLine(await cw(['session', 'attach', 'portless']), 'NO_PORTS_AVAILABLE');
      } finally {
        await new Promise<void>((resolve) => squatter.close(() => resolve()));
      }
    }, 60_000);

    it('DISK_LIMIT_EXCEEDED when the workspace is already over budget', async () => {
      await writeFile(
        join(fx.root, 'crossweave.config.json'),
        JSON.stringify({ disk: { perSessionBytes: 1, perWorkspaceBytes: 1 } }),
      );
      await cw(['init']);
      // The first session is created against an empty workspace, so nothing is over
      // budget yet; its worktree is what puts the next one over.
      expect((await cw(['session', 'new', '--name', 'first', '--agent', 'claude'])).exitCode).toBe(0);

      const r = await cw(['session', 'new', '--name', 'second', '--agent', 'claude']);
      expectOneCodeLine(r, 'DISK_LIMIT_EXCEEDED');
      expect(r.stderr).toContain('cw gc');
    }, 60_000);
  });
});
