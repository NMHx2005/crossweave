import type { Database } from 'bun:sqlite';
import { SessionRepo } from '../db/repositories/session.js';
import { WorkspaceRepo } from '../db/repositories/workspace.js';
import { CrossweaveError } from '../core/errors.js';
import { removeWorktree, deleteBranch, listWorktreePaths } from '../isolation/worktree.js';
import { measureWorktrees } from '../isolation/disk-guard.js';

export interface GcResult {
  removed: string[];
  reclaimedBytes: number;
}

/**
 * Reclaim every session that has ended: its worktree, its branch and its row.
 *
 * Deliberately the same disposal `session rm` performs, so a name freed by gc behaves
 * exactly like a name freed by hand. Live sessions are never touched, and a failure
 * on one session does not abandon the rest — a half-finished gc that stops at the
 * first stubborn worktree is worse than one that reports what it could not take.
 */
export async function collectGarbage(
  db: Database,
  projectRoot: string,
  workspaceId: string,
): Promise<GcResult> {
  const workspace = new WorkspaceRepo(db).findById(workspaceId);
  if (!workspace) {
    throw new CrossweaveError('WORKSPACE_NOT_FOUND', `No such workspace: ${workspaceId}`);
  }

  const repo = new SessionRepo(db);
  const sizes = new Map(measureWorktrees(db, workspaceId).map((u) => [u.sessionId, u.bytes]));
  const ended = repo
    .listByWorkspace(workspaceId)
    .filter((s) => s.status === 'dead' || s.status === 'landed');

  const removed: string[] = [];
  let reclaimedBytes = 0;

  for (const session of ended) {
    const own =
      session.worktreePath !== null && session.worktreePath !== workspace.rootPath
        ? session.worktreePath
        : null;
    if (own !== null) await removeWorktree(workspace.rootPath, own).catch(() => undefined);
    if (session.branch !== null) {
      await deleteBranch(workspace.rootPath, session.branch).catch(() => undefined);
    }
    repo.delete(session.id);
    removed.push(session.name);
    reclaimedBytes += sizes.get(session.id) ?? 0;
  }

  // Worktrees git knows about that no session row claims. `cw workspace delete`
  // removes the workspace row and cascades away its sessions WITHOUT touching the
  // disk, so every worktree it leaves behind is invisible to the loop above — it
  // walks sessions, and those no longer exist. Found by end-to-end testing of M0:
  // two orphans and three branches survived a `workspace delete --force`.
  for (const path of await listWorktreePaths(workspace.rootPath)) {
    if (repo.findByWorktreePath(path) !== undefined) continue;
    await removeWorktree(workspace.rootPath, path).catch(() => undefined);
    removed.push(path.split('/').pop() ?? path);
  }

  return { removed, reclaimedBytes };
}
