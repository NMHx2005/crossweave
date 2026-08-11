import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { simpleGit } from 'simple-git';
import { newId } from '../core/ids.js';
import { crossweaveDir } from '../core/paths.js';
import { SessionRepo, type SessionRow } from '../db/repositories/session.js';
import type { LeaseManager } from '../isolation/leases/manager.js';

export const INTEGRATION_SESSION_NAME = '__integration__';
export const INTEGRATION_BRANCH = 'cw/integration';

export interface IntegrationWorktree {
  sessionId: string;
  path: string;
  branch: string;
}

/**
 * Creates (or reuses) the Convergence Engine's scratch worktree and its
 * backing session row. Idempotent and safe to call on every trial — the
 * common case is a fast row lookup, not a fresh `git worktree add`.
 *
 * A stale row (worktree directory gone, e.g. after a crash mid-teardown) is
 * deleted and recreated from scratch rather than trusted — a torn-down
 * worktree's row pointing at a path that no longer exists would make every
 * lease acquisition succeed while every git command against it fails.
 */
export async function ensureIntegrationWorktree(
  db: Database,
  workspaceId: string,
  projectRoot: string,
): Promise<IntegrationWorktree> {
  const sessions = new SessionRepo(db);
  const existing = sessions.findByName(workspaceId, INTEGRATION_SESSION_NAME);
  if (existing?.worktreePath !== undefined && existing?.worktreePath !== null && existsSync(existing.worktreePath)) {
    return { sessionId: existing.id, path: existing.worktreePath, branch: existing.branch ?? INTEGRATION_BRANCH };
  }
  if (existing) sessions.delete(existing.id);

  const path = join(crossweaveDir(projectRoot), 'integration');
  const git = simpleGit(projectRoot);
  // Best-effort cleanup of a previous crash's half-torn-down state — a
  // stale worktree registration or branch left over from before must not
  // make the fresh `worktree add` below fail.
  await git.raw(['worktree', 'remove', '--force', path]).catch(() => undefined);
  await git.raw(['branch', '-D', INTEGRATION_BRANCH]).catch(() => undefined);

  const forkPoint = (await git.raw(['rev-parse', '--verify', 'HEAD'])).trim();
  await git.raw(['worktree', 'add', '-b', INTEGRATION_BRANCH, path, forkPoint]);

  const id = newId('s');
  const now = new Date().toISOString();
  const row: SessionRow = {
    id, workspaceId, name: INTEGRATION_SESSION_NAME, agentKind: 'integration', adapter: 'integration',
    status: 'idle', worktreePath: path, branch: INTEGRATION_BRANCH, createdAt: now, lastActiveAt: now,
    tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
  };
  sessions.insert(row);
  return { sessionId: id, path, branch: INTEGRATION_BRANCH };
}

/**
 * Runs `fn` with the integration worktree's resource lease held — exactly
 * a session's own lease lifecycle (acquired for the duration of real work,
 * released immediately after), not held permanently. Only needed around an
 * actual `converge.testCommand` run; a bare merge trial touches no
 * port/db/docker/cache and does not need this.
 */
export async function withIntegrationLease<T>(
  leaseManager: LeaseManager,
  sessionId: string,
  fn: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
  const env = await leaseManager.acquire(sessionId);
  try {
    return await fn(env);
  } finally {
    leaseManager.release(sessionId);
  }
}
