import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { CrossweaveError } from '../core/errors.js';
import { assertContained, crossweaveDir } from '../core/paths.js';

export interface WorktreeHandle {
  path: string;
  branch: string;
  /**
   * The commit `branch` was created from — `projectRoot`'s HEAD at this exact
   * moment, which is what `git worktree add -b` branches from. Captured here and
   * stored by the caller because it is only true NOW: the user is free to check out
   * anything they like in their own checkout afterwards, and re-deriving the fork
   * point later from whatever HEAD happens to point at then attributes their commits
   * to this session (see EventLedger.syncCommits).
   */
  forkPoint: string;
}

function worktreeRoot(projectRoot: string): string {
  return join(crossweaveDir(projectRoot), 'worktrees');
}

/**
 * True when `worktreePath` is one crossweave created.
 *
 * crossweave creates worktrees in exactly two places, both under `.crossweave/`: a
 * session's at `.crossweave/worktrees/<sessionId>` and the integration scratch at
 * `.crossweave/integration`. So `.crossweave/` is the whole of what crossweave owns
 * on disk, and any other worktree `git worktree list` reports — `.worktrees/feat-x`,
 * a second checkout for a long-running branch — is the user's own, uncommitted work
 * included. No session row claims those either, which is why "unclaimed" alone is not
 * enough to make one ours to delete.
 *
 * Fails closed: an unresolvable `.crossweave` (it does not exist yet) reports "not
 * ours", so the caller skips it rather than reclaiming something it cannot prove it
 * created.
 */
export function isCrossweaveWorktree(projectRoot: string, worktreePath: string): boolean {
  try {
    assertContained(crossweaveDir(projectRoot), worktreePath);
    return true;
  } catch {
    return false;
  }
}

/** A ref name safe to hand git: no leading dash (an option), no spaces or oddities. */
const BASE_REF = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/;

export async function createWorktree(
  projectRoot: string,
  sessionId: string,
  branch: string,
  /** Branch or commit to start from; HEAD when omitted. */
  base?: string,
): Promise<WorktreeHandle> {
  if (base !== undefined && !BASE_REF.test(base)) {
    throw new CrossweaveError('INVALID_BASE', `Not a branch or commit name: ${base}`);
  }
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
  let forkPoint: string;
  try {
    forkPoint = (await git.raw(['rev-parse', '--verify', `${base ?? 'HEAD'}^{commit}`])).trim();
  } catch (cause) {
    throw new CrossweaveError(
      'WORKTREE_FAILED',
      base === undefined
        ? `repository has no commits, cannot create worktree for ${branch}: ${(cause as Error).message}`
        : `cannot branch ${branch} from ${base}: ${(cause as Error).message}`,
    );
  }

  try {
    // The captured hash is passed as the explicit start point, not left implicit:
    // `worktree add -b <branch> <path>` branches from whatever HEAD is when it runs,
    // which is not necessarily what `rev-parse` just read. Naming it makes the
    // recorded fork point exactly the commit the branch was created at.
    await git.raw(['worktree', 'add', '-b', branch, path, forkPoint]);
  } catch (cause) {
    throw new CrossweaveError(
      'WORKTREE_FAILED',
      `git worktree add failed for ${branch}: ${(cause as Error).message}`,
    );
  }

  return { path, branch, forkPoint };
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

/**
 * Whether a session's branch or worktree holds work that exists nowhere else: a
 * commit no other branch contains, or anything `git status` reports (untracked files
 * included — an agent's new file is work too).
 *
 * "No other branch" rather than "not on base" because the base is chosen per land,
 * not stored; once any branch holds the commits (the user merged by hand, or kept a
 * copy) deleting this one loses nothing. Any git failure answers true: the caller
 * uses this to decide whether deletion is safe, and "cannot tell" is not safe.
 */
export async function hasUnlandedWork(
  projectRoot: string,
  branch: string | null,
  worktreePath: string | null,
): Promise<boolean> {
  try {
    if (worktreePath !== null && existsSync(worktreePath)) {
      const status = await simpleGit(worktreePath).raw(['status', '--porcelain']);
      if (status.trim() !== '') return true;
    }
    if (branch !== null) {
      const heads = await simpleGit(projectRoot).raw(['for-each-ref', '--format=%(refname)', 'refs/heads/']);
      const others = heads.split('\n').filter((r) => r !== '' && r !== `refs/heads/${branch}`);
      const unique = await simpleGit(projectRoot).raw(['rev-list', '--count', `refs/heads/${branch}`, '--not', ...others]);
      if (Number(unique.trim()) > 0) return true;
    }
    return false;
  } catch {
    return true;
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
