import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { $ } from 'bun';
import { existsSync } from 'node:fs';
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
    expect((await cw(['session', 'list'])).stdout).toContain('dead');
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

  it('daemon stop reports success without starting a daemon when none is running', async () => {
    const r = await cw(['daemon', 'stop']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('no daemon running');
    // And it must not have spawned one on the way out.
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(fx.root, '.crossweave', 'daemon.sock'))).toBe(false);
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
});
