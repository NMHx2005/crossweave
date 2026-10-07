import { describe, it, expect } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { $ } from 'bun';
import { fail, projectRootForContext } from '../../src/cli/context.js';
import { CrossweaveError } from '../../src/core/errors.js';
import { makeGitFixture } from '../helpers/git-fixture.js';

describe('fail', () => {
  // Regression: fail() collapses [\r\n] and trims. A lone \r with no adjacent \n is
  // exactly the case that distinguishes the real regex (/\s*[\r\n]+\s*/g) from the
  // mutated one (/\s*\n\s*/g): no wrapped subprocess error observed so far in the CLI
  // actually contains a bare \r (git never emits one, and it sanitizes \r out of a
  // worktree lock's --reason field too — see tests/cli/cli.test.ts), so an indirect,
  // git-driven repro cannot catch this. Only a direct call can.
  it('collapses a lone carriage return into one clean stderr line', () => {
    // bun:test's spyOn does not intercept process.exit or process.stderr.write here —
    // both are effectively no-ops under it (calls go untracked, verified separately).
    // Reassign directly instead.
    const originalWrite = process.stderr.write;
    const originalExit = process.exit;
    const writes: string[] = [];
    const exitCodes: Array<number | undefined> = [];
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    process.exit = ((code?: number): never => {
      exitCodes.push(code);
      return undefined as never;
    }) as typeof process.exit;

    try {
      fail(new CrossweaveError('SOME_CODE', 'line one\rline two'));
    } finally {
      process.stderr.write = originalWrite;
      process.exit = originalExit;
    }

    expect(exitCodes).toEqual([1]);
    expect(writes).toEqual(['SOME_CODE: line one line two\n']);
  });
});

describe('projectRootForContext', () => {
  const session = { CW_SESSION_ID: 's_1' };

  it('resolves from the owning repository instead of a linked session worktree', async () => {
    const fixture = await makeGitFixture();
    const worktree = join(fixture.root, '.crossweave', 'worktrees', 'session');
    await mkdir(dirname(worktree), { recursive: true });
    try {
      await $`git worktree add -b cw/session ${worktree}`.cwd(fixture.root).quiet();
      await mkdir(join(worktree, 'sub'), { recursive: true });

      expect(projectRootForContext(worktree, { ...session, CW_WORKSPACE_ROOT: fixture.root })).toBe(fixture.root);
      expect(projectRootForContext(join(worktree, 'sub'), { ...session, CW_WORKSPACE_ROOT: fixture.root })).toBe(fixture.root);
      expect(projectRootForContext(worktree, {})).toBe(worktree);
      // Without a session id the variable alone is not a session context.
      expect(projectRootForContext(worktree, { CW_WORKSPACE_ROOT: fixture.root })).toBe(worktree);
    } finally {
      await $`git worktree remove ${worktree}`.cwd(fixture.root).quiet();
      await fixture.cleanup();
    }
  });

  it('follows the current directory once the shell has moved into another repository', async () => {
    const owner = await makeGitFixture();
    const other = await makeGitFixture();
    try {
      expect(projectRootForContext(other.root, { ...session, CW_WORKSPACE_ROOT: owner.root })).toBe(other.root);
    } finally {
      await owner.cleanup();
      await other.cleanup();
    }
  });

  it('refuses a relative workspace root and names the variable', () => {
    let caught: unknown;
    try {
      projectRootForContext('/tmp', { ...session, CW_WORKSPACE_ROOT: 'relative' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CrossweaveError);
    expect((caught as CrossweaveError).code).toBe('INVALID_ARGUMENTS');
    expect((caught as CrossweaveError).message).toContain('CW_WORKSPACE_ROOT');
  });
});
