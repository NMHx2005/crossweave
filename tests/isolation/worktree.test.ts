import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { makeGitFixture, type GitFixture } from '../helpers/git-fixture.js';
import { createWorktree, removeWorktree, listWorktreePaths } from '../../src/isolation/worktree.js';

let fx: GitFixture;
beforeEach(async () => { fx = await makeGitFixture(); });
afterEach(async () => { await fx.cleanup(); });

describe('createWorktree', () => {
  it('creates a worktree under .crossweave/worktrees on a new branch', async () => {
    const h = await createWorktree(fx.root, 's_one', 'cw/one');
    expect(h.path).toBe(join(fx.root, '.crossweave', 'worktrees', 's_one'));
    expect(h.branch).toBe('cw/one');
    expect(existsSync(join(h.path, 'README.md'))).toBe(true);

    const branch = await $`git rev-parse --abbrev-ref HEAD`.cwd(h.path).text();
    expect(branch.trim()).toBe('cw/one');
  });

  it('isolates writes between two worktrees', async () => {
    const a = await createWorktree(fx.root, 's_a', 'cw/a');
    const b = await createWorktree(fx.root, 's_b', 'cw/b');
    const { writeFile, readFile } = await import('node:fs/promises');
    await writeFile(join(a.path, 'only-in-a.txt'), 'a');
    expect(existsSync(join(b.path, 'only-in-a.txt'))).toBe(false);
    expect((await readFile(join(a.path, 'only-in-a.txt'), 'utf8'))).toBe('a');
  });

  it('throws BRANCH_EXISTS when the branch is already taken', async () => {
    await createWorktree(fx.root, 's_one', 'cw/one');
    await expect(createWorktree(fx.root, 's_two', 'cw/one')).rejects.toMatchObject({
      code: 'BRANCH_EXISTS',
    });
  });

  it('throws WORKTREE_FAILED on a repo with no commits', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const empty = await mkdtemp(join(tmpdir(), 'cw-empty-'));
    // Every temp directory this suite creates must be removed. An earlier version of
    // this test leaked one per run; 52 of them accumulated in TMPDIR and the growing
    // directory was a direct cause of the beforeEach hook timeouts elsewhere.
    try {
      await $`git init -q -b main`.cwd(empty).quiet();
      await expect(createWorktree(empty, 's_x', 'cw/x')).rejects.toMatchObject({
        code: 'WORKTREE_FAILED',
      });
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

describe('removeWorktree and listWorktreePaths', () => {
  it('lists then removes a worktree', async () => {
    const h = await createWorktree(fx.root, 's_one', 'cw/one');
    expect(await listWorktreePaths(fx.root)).toContain(h.path);
    await removeWorktree(fx.root, h.path);
    expect(existsSync(h.path)).toBe(false);
    expect(await listWorktreePaths(fx.root)).not.toContain(h.path);
  });

  it('refuses to remove a path outside the project root', async () => {
    await expect(removeWorktree(fx.root, '/tmp')).rejects.toMatchObject({ code: 'PATH_ESCAPE' });
  });

  // Regression: `makeGitFixture` realpaths its root, which hides this. Reaching the
  // same repo through a symlink is the portable way to hand in a non-canonical root —
  // it is the same situation as macOS's /var -> /private/var.
  it('excludes the main worktree even when given a non-canonical root', async () => {
    const { mkdtemp, rm, symlink } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const h = await createWorktree(fx.root, 's_one', 'cw/one');
    const linkDir = await mkdtemp(join(tmpdir(), 'cw-alias-'));
    const aliasRoot = join(linkDir, 'alias');
    await symlink(fx.root, aliasRoot);
    try {
      const paths = await listWorktreePaths(aliasRoot);
      expect(paths).toContain(h.path);
      expect(paths).not.toContain(fx.root);
      expect(paths).toHaveLength(1);
    } finally {
      await rm(linkDir, { recursive: true, force: true });
    }
  });
});
