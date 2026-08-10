import type { Database } from 'bun:sqlite';
import { rmSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { SessionRepo } from '../db/repositories/session.js';
import { WorkspaceRepo, type WorkspaceRow } from '../db/repositories/workspace.js';
import { LeaseRepo } from '../db/repositories/lease.js';
import { CrossweaveError } from '../core/errors.js';
import { assertContained, crossweaveDir } from '../core/paths.js';
import { removeWorktree, deleteBranch, listWorktreePaths } from '../isolation/worktree.js';
import { measureWorktrees, directorySize } from '../isolation/disk-guard.js';

export interface GcResult {
  removed: string[];
  reclaimedBytes: number;
}

/**
 * `createWorktree` returns before `sessions.insert` commits the row that claims it,
 * and RPCs are dispatched unserialized — so a worktree can sit on disk for a brief
 * moment with no row pointing at it yet, which is indistinguishable from a genuine
 * orphan by path alone. A worktree younger than this is left alone rather than
 * reclaimed: a `create()` call that has not finished within it is not something this
 * codebase's synchronous single-daemon dispatch should ever produce, so the margin
 * is generous on purpose.
 */
const ORPHAN_GRACE_MS = 5_000;

function requireWorkspace(db: Database, workspaceId: string): WorkspaceRow {
  const workspace = new WorkspaceRepo(db).findById(workspaceId);
  if (!workspace) {
    throw new CrossweaveError('WORKSPACE_NOT_FOUND', `No such workspace: ${workspaceId}`);
  }
  return workspace;
}

/**
 * Delete the per-session directories and files the leases point at.
 *
 * Nothing else ever removes these, and `measureWorktrees` cannot see them, so without
 * this a session's cache and copied database survive every reclaim and grow invisibly
 * against the very budget the disk guard enforces.
 *
 * Must run BEFORE the session row is deleted — that cascades the lease rows away.
 * Only absolute values are touched: under the `schema` db strategy the `db` lease
 * holds a Postgres schema name, not a path. `assertContained` is what decides a value
 * read back out of the database is safe to delete at all.
 */
function disposeLeasedPaths(leases: LeaseRepo, workspace: WorkspaceRow, sessionId: string): void {
  for (const lease of leases.listBySession(sessionId)) {
    if (lease.kind !== 'cache' && lease.kind !== 'db') continue;
    if (!isAbsolute(lease.value)) continue;
    try {
      const path = assertContained(crossweaveDir(workspace.rootPath), lease.value);
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Best effort, like every other disposal here: a stubborn cache directory must
      // not abandon the rest of the sweep.
    }
  }
}

/**
 * Reclaim every session that has ended: its worktree, its branch, its leased cache and
 * database, and its row.
 *
 * Deliberately the same disposal `session rm` performs, so a name freed by gc behaves
 * exactly like a name freed by hand. Live sessions are never touched, and a failure
 * on one session does not abandon the rest — a half-finished gc that stops at the
 * first stubborn worktree is worse than one that reports what it could not take.
 *
 * This is the half that only ever runs when the user asks for it. `cw session kill`
 * without `--rm-worktree` leaves a session `dead` with its work intact on purpose
 * (M4's `cw land` needs the branch), so running this unprompted — on daemon boot, say
 * — would destroy work nobody offered up.
 */
async function reclaimEnded(
  db: Database,
  workspace: WorkspaceRow,
): Promise<GcResult & { disposedPaths: Set<string> }> {
  const repo = new SessionRepo(db);
  const leases = new LeaseRepo(db);
  const sizes = new Map(measureWorktrees(db, workspace.id).map((u) => [u.sessionId, u.bytes]));
  const ended = repo
    .listByWorkspace(workspace.id)
    .filter((s) => s.status === 'dead' || s.status === 'landed');

  const removed: string[] = [];
  let reclaimedBytes = 0;
  // Paths handled by this loop, whether or not their `removeWorktree` actually
  // succeeded — a failed removal here still deletes the row (best effort, does not
  // abandon the rest of the sweep), which would otherwise make the orphan pass pick
  // the very same worktree back up and report it a second time.
  const disposedPaths = new Set<string>();

  for (const session of ended) {
    const own =
      session.worktreePath !== null && session.worktreePath !== workspace.rootPath
        ? session.worktreePath
        : null;
    if (own !== null) {
      disposedPaths.add(own);
      await removeWorktree(workspace.rootPath, own).catch(() => undefined);
    }
    if (session.branch !== null) {
      await deleteBranch(workspace.rootPath, session.branch).catch(() => undefined);
    }
    disposeLeasedPaths(leases, workspace, session.id);
    repo.delete(session.id);
    removed.push(session.name);
    reclaimedBytes += sizes.get(session.id) ?? 0;
  }

  return { removed, reclaimedBytes, disposedPaths };
}

/**
 * Worktrees git knows about that no session row claims. `cw workspace delete` removes
 * the workspace row and cascades away its sessions WITHOUT touching the disk, so every
 * worktree it leaves behind is invisible to a walk over sessions — those no longer
 * exist. Found by end-to-end testing of M0: two orphans and three branches survived a
 * `workspace delete --force`.
 */
async function sweepOrphans(
  db: Database,
  workspace: WorkspaceRow,
  disposedPaths: Set<string>,
): Promise<GcResult> {
  const repo = new SessionRepo(db);
  const removed: string[] = [];
  let reclaimedBytes = 0;

  for (const path of await listWorktreePaths(workspace.rootPath)) {
    if (repo.findByWorktreePath(path) !== undefined) continue;
    if (disposedPaths.has(path)) continue;

    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      continue; // vanished mid-sweep; nothing left to reclaim
    }
    if (Date.now() - mtimeMs < ORPHAN_GRACE_MS) continue;

    reclaimedBytes += directorySize(path);
    await removeWorktree(workspace.rootPath, path).catch(() => undefined);
    removed.push(path.split('/').pop() ?? path);
  }

  return { removed, reclaimedBytes };
}

/**
 * The orphan sweep on its own — safe to run unprompted, because a worktree no session
 * row claims is by definition work nothing can still reach.
 *
 * This is what the daemon runs at boot. It deliberately does NOT reclaim ended
 * sessions: a killed session's worktree and branch are still referenced by its row and
 * still wanted.
 */
export async function collectOrphans(db: Database, workspaceId: string): Promise<GcResult> {
  return sweepOrphans(db, requireWorkspace(db, workspaceId), new Set());
}

/** The full sweep behind `cw gc`: ended sessions first, then whatever is orphaned. */
export async function collectGarbage(db: Database, workspaceId: string): Promise<GcResult> {
  const workspace = requireWorkspace(db, workspaceId);
  const ended = await reclaimEnded(db, workspace);
  const orphans = await sweepOrphans(db, workspace, ended.disposedPaths);
  return {
    removed: [...ended.removed, ...orphans.removed],
    reclaimedBytes: ended.reclaimedBytes + orphans.reclaimedBytes,
  };
}
