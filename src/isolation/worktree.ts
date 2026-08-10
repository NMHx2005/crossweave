import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { CrossweaveError } from '../core/errors.js';
import { assertContained, crossweaveDir } from '../core/paths.js';

export interface WorktreeHandle {
  path: string;
  branch: string;
}

function worktreeRoot(projectRoot: string): string {
  return join(crossweaveDir(projectRoot), 'worktrees');
}

export async function createWorktree(
  projectRoot: string,
  sessionId: string,
  branch: string,
): Promise<WorktreeHandle> {
  const path = join(worktreeRoot(projectRoot), sessionId);
  const git = simpleGit(projectRoot);

  const branches = await git.branch();
  if (branches.all.includes(branch)) {
    throw new CrossweaveError('BRANCH_EXISTS', `Branch already exists: ${branch}`);
  }

  // Modern git infers `--orphan` when there is no commit to branch from, so
  // `worktree add` SUCCEEDS on an empty repository. Checking HEAD explicitly is what
  // turns that into the WORKTREE_FAILED the contract promises. Keep it after the
  // branch check so BRANCH_EXISTS still wins on a normal repo.
  try {
    await git.raw(['rev-parse', '--verify', 'HEAD']);
  } catch (cause) {
    throw new CrossweaveError(
      'WORKTREE_FAILED',
      `repository has no commits, cannot create worktree for ${branch}: ${(cause as Error).message}`,
    );
  }

  try {
    await git.raw(['worktree', 'add', '-b', branch, path]);
  } catch (cause) {
    throw new CrossweaveError(
      'WORKTREE_FAILED',
      `git worktree add failed for ${branch}: ${(cause as Error).message}`,
    );
  }

  return { path, branch };
}

export async function removeWorktree(projectRoot: string, worktreePath: string): Promise<void> {
  assertContained(projectRoot, worktreePath);
  const git = simpleGit(projectRoot);
  try {
    await git.raw(['worktree', 'remove', '--force', worktreePath]);
  } catch (cause) {
    throw new CrossweaveError(
      'WORKTREE_REMOVE_FAILED',
      `git worktree remove failed for ${worktreePath}: ${(cause as Error).message}`,
    );
  }
}

export async function deleteBranch(projectRoot: string, branch: string): Promise<void> {
  try {
    await simpleGit(projectRoot).raw(['branch', '-D', branch]);
  } catch (cause) {
    throw new CrossweaveError(
      'BRANCH_DELETE_FAILED',
      `git branch -D failed for ${branch}: ${(cause as Error).message}`,
    );
  }
}

export async function listWorktreePaths(projectRoot: string): Promise<string[]> {
  // `git worktree list` always prints CANONICAL paths, but callers may hand us a
  // non-canonical root — on macOS `/var` is a symlink to `/private/var`, and any
  // path round-tripped through config or the database can arrive that way. Comparing
  // raw strings then fails to exclude the main worktree and leaks it into the result.
  const realRoot = realpathSync(projectRoot);
  const out = await simpleGit(projectRoot).raw(['worktree', 'list', '--porcelain']);
  return out
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length).trim())
    .filter((p) => p !== realRoot);
}
