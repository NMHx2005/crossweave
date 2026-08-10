import { existsSync } from 'node:fs';
import type { Database } from 'bun:sqlite';
import { SessionRepo } from '../db/repositories/session.js';
import { LeaseRepo } from '../db/repositories/lease.js';

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process — dead. EPERM: exists, owned by someone else — alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Reconcile daemon state once, at boot. Every session the DB believes is `running`
 * or `waiting` is necessarily a leftover from a PREVIOUS daemon — this instance has
 * not started anything yet — so each one is checked and, if stale, marked `dead`
 * with its leases released.
 *
 * Known, accepted limitation: `isProcessAlive` proves a pid is held by SOME process,
 * not that it's the one this session originally spawned. If the OS recycles a dead
 * agent's pid before this reconcile runs, a session can be wrongly left `running`.
 * Verifying process identity across macOS/Linux without a native dependency is
 * real, fragile extra work for a low-probability window; documented rather than
 * either ignored or over-built here — see the M2 known-limitations doc.
 */
export function reconcile(db: Database, _projectRoot: string): void {
  const sessions = new SessionRepo(db);
  const leases = new LeaseRepo(db);

  const workspaceIds = (
    db.prepare('SELECT id FROM workspace').all() as { id: string }[]
  ).map((r) => r.id);

  for (const workspaceId of workspaceIds) {
    for (const session of sessions.listLive(workspaceId)) {
      if (session.status !== 'running' && session.status !== 'waiting') continue;

      const worktreeGone = session.worktreePath !== null && !existsSync(session.worktreePath);
      const pidGone = typeof session.pid === 'number' ? !isProcessAlive(session.pid) : true;

      if (worktreeGone || pidGone) {
        sessions.updateStatus(session.id, 'dead', null);
        leases.release(session.id);
      }
    }
  }
}
