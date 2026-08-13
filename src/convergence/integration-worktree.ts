import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { simpleGit } from 'simple-git';
import { newId } from '../core/ids.js';
import { crossweaveDir } from '../core/paths.js';
import { RESERVED_SESSION_NAME } from '../domain/session.js';
import { SessionRepo, type SessionRow } from '../db/repositories/session.js';
import { deleteBranch, removeWorktree } from '../isolation/worktree.js';
import type { LeaseManager } from '../isolation/leases/manager.js';

// Re-exported (not re-declared) so this module and `src/domain/session.ts` can never
// drift apart on the one string that has to match for the reservation to actually
// protect the row this engine creates.
export const INTEGRATION_SESSION_NAME = RESERVED_SESSION_NAME;
export const INTEGRATION_BRANCH = 'cw/integration';

export interface IntegrationWorktree {
  sessionId: string;
  path: string;
  branch: string;
}

/**
 * A worktree directory that exists but lost its `.git` file (or never had one) is
 * exactly the "lease succeeds, every git command fails" trap this module's docs warn
 * about — checking the directory alone would call that healthy.
 */
function isHealthyWorktree(path: string): boolean {
  return existsSync(path) && existsSync(join(path, '.git'));
}

// Keyed by workspaceId: two concurrent callers for the SAME workspace (Task 4's
// scheduler and Task 6's `cw land` handler can both call this independently on the
// daemon's event loop) must resolve to the one in-flight creation attempt, not race
// each other through the check-then-act below — the second one's stale-branch cleanup
// would otherwise delete the branch the first just created.
const inFlight = new Map<string, Promise<IntegrationWorktree>>();

// Keyed by workspaceId — the tail of the chain of every `withIntegrationWorktreeLock`
// call for that workspace, so far. Not related to `inFlight` above: that map only
// coalesces concurrent CREATIONS of the worktree; this one serializes every caller's
// actual USE of it once created (a merge trial, a full-integration run, a land).
const tails = new Map<string, Promise<unknown>>();

/**
 * Serializes all access to one workspace's integration worktree across every caller —
 * scheduler ticks (pairwise trials and full-integration runs) and `cw land` alike.
 *
 * Both `ConvergenceScheduler` and `landSession` drive the SAME scratch worktree
 * (`ensureIntegrationWorktree`'s `.crossweave/integration`) via real `git`
 * mutations — `git merge --abort`, `checkout -B cw/trial`, `git reset --hard`, a
 * rebase — with genuine async yields in between (a `withIntegrationLease` port
 * allocation does real network I/O). Without this lock, a scheduler tick's pairwise
 * trial can reset/overwrite the worktree while a `cw land` is suspended mid-lease-
 * acquire, silently invalidating the trial `cw land` is about to test against — or
 * the reverse, a land aborting a scheduler trial mid-flight. This lock is the only
 * thing that makes "one workspace's integration worktree, one mutator at a time"
 * true across both call sites; see the scheduler and `land.ts` for where it's used.
 *
 * A plain promise-chaining mutex: each call tacks itself onto the tail of the
 * previous one, so calls for the SAME workspace run strictly one at a time, in
 * order, while calls for DIFFERENT workspaces never wait on each other (the map is
 * keyed by workspaceId, not global). `fn` runs regardless of whether the prior
 * holder resolved or rejected — one caller's failure must not permanently wedge
 * every later caller for the same workspace.
 */
export function withIntegrationWorktreeLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  const prior = tails.get(workspaceId) ?? Promise.resolve();
  const result = prior.then(fn, fn);
  // Swallow the outcome for chaining purposes only — the real result/rejection
  // still propagates to this call's own caller via `result` below. Without this,
  // one caller's rejection would permanently reject the tail and every later
  // caller's `.then(fn, fn)` would never even run `fn`.
  tails.set(workspaceId, result.catch(() => undefined));
  return result;
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
  const existing = inFlight.get(workspaceId);
  if (existing) return existing;
  const promise = ensureIntegrationWorktreeUncached(db, workspaceId, projectRoot).finally(() => {
    inFlight.delete(workspaceId);
  });
  inFlight.set(workspaceId, promise);
  return promise;
}

async function ensureIntegrationWorktreeUncached(
  db: Database,
  workspaceId: string,
  projectRoot: string,
): Promise<IntegrationWorktree> {
  const sessions = new SessionRepo(db);
  const existing = sessions.findByName(workspaceId, INTEGRATION_SESSION_NAME);
  if (existing?.worktreePath !== undefined && existing?.worktreePath !== null && isHealthyWorktree(existing.worktreePath)) {
    return { sessionId: existing.id, path: existing.worktreePath, branch: existing.branch ?? INTEGRATION_BRANCH };
  }
  if (existing) sessions.delete(existing.id);

  const path = join(crossweaveDir(projectRoot), 'integration');
  // Best-effort cleanup of a previous crash's half-torn-down state — a
  // stale worktree registration or branch left over from before must not
  // make the fresh `worktree add` below fail.
  await removeWorktree(projectRoot, path).catch(() => undefined);
  await deleteBranch(projectRoot, INTEGRATION_BRANCH).catch(() => undefined);

  const git = simpleGit(projectRoot);
  const forkPoint = (await git.raw(['rev-parse', '--verify', 'HEAD'])).trim();
  await git.raw(['worktree', 'add', '-b', INTEGRATION_BRANCH, path, forkPoint]);

  const id = newId('s');
  const now = new Date().toISOString();
  const row: SessionRow = {
    id, workspaceId, name: INTEGRATION_SESSION_NAME, agentKind: 'integration', adapter: 'integration',
    status: 'idle', worktreePath: path, branch: INTEGRATION_BRANCH, createdAt: now, lastActiveAt: now,
    tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null, enforcementTier: 'T3', pid: null,
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
