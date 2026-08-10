import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { commitFile, makeGitFixture, type GitFixture } from '../helpers/git-fixture.js';

const CLI = new URL('../../src/cli/index.ts', import.meta.url).pathname;
let fx: GitFixture;

interface CwResult { exitCode: number; stdout: string; stderr: string }

async function cw(args: string[], cwd?: string): Promise<CwResult> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: cwd ?? fx.root, stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, stdout, stderr };
}

beforeEach(async () => {
  fx = await makeGitFixture();
});

afterEach(async () => {
  await cw(['daemon', 'stop']);
  await fx.cleanup();
});

describe('cw blame', () => {
  it('attributes a committed line to the session that made the commit', async () => {
    await cw(['init']);
    const created = await cw(['session', 'new', '--name', 'auth', '--agent', 'claude']);
    const worktreePath = created.stdout.trim().split('\t')[3];
    if (worktreePath === undefined || worktreePath === '-') throw new Error('expected a worktree path');
    await commitFile(worktreePath, 'auth.ts', 'export const x = 1;\n', 'add auth.ts');

    const r = await cw(['blame', 'auth.ts:1']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('auth');
  }, 30_000);

  it('resolves the target against the user\'s cwd, not the project root', async () => {
    await cw(['init']);
    const created = await cw(['session', 'new', '--name', 'auth', '--agent', 'claude']);
    const worktreePath = created.stdout.trim().split('\t')[3];
    if (worktreePath === undefined || worktreePath === '-') throw new Error('expected a worktree path');
    await commitFile(worktreePath, 'src/auth.ts', 'export const x = 1;\n', 'add src/auth.ts');

    const { mkdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const subdir = join(fx.root, 'sub');
    await mkdir(subdir, { recursive: true });

    // Sent as `src/auth.ts` after resolving against the subdirectory. Sending the
    // argument verbatim made this "no attribution found" — the daemon blames from
    // the project root, where `../src/auth.ts` means nothing.
    const r = await cw(['blame', '../src/auth.ts:1'], subdir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('auth');
    expect(r.stdout.toLowerCase()).not.toContain('no attribution');

    // A target outside the repo is an error, not a silent miss.
    const outside = await cw(['blame', '../../etc/hosts:1'], subdir);
    expect(outside.exitCode).toBe(1);
    expect(outside.stderr).toMatch(/^PATH_ESCAPE: /);
  }, 30_000);

  it('reports no attribution for an unknown file, cleanly', async () => {
    await cw(['init']);
    const r = await cw(['blame', 'nope.ts:1']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toLowerCase()).toContain('no attribution');
  }, 30_000);

  it('rejects a malformed target with a CODE: line', async () => {
    await cw(['init']);
    const r = await cw(['blame', 'not-a-valid-target']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/^[A-Z_]+: /);
  }, 30_000);

  it('rejects a non-numeric line with a CODE: line', async () => {
    await cw(['init']);
    const r = await cw(['blame', 'auth.ts:notanumber']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/^INVALID_ARGUMENTS: /);
  }, 30_000);
});
