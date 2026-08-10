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
 * not started anything yet — so each one is checked and, if stale, brought back to
 * a state that reflects reality, with its leases released either way (a dead
 * process can't hold live port/docker/cache resources regardless of which case
 * below applies).
 *
 * The two ways a session can be stale are NOT the same, and treating them as one
 * (as an earlier version of this function did) is destructive: a daemon crash or
 * an ordinary restart (host reboot, `cw daemon stop` for an upgrade) must not be
 * indistinguishable from a deliberate `cw session kill`.
 *
 * - **Worktree gone**: there is truly nothing left to resume — the work itself no
 *   longer exists on disk. Marked `dead`, matching existing terminal semantics:
 *   `assertResumable` refuses to restart it, and `cw gc` may reclaim its row.
 * - **Pid not alive, but the worktree still exists**: the agent process died —
 *   because it crashed, or because the daemon supervising it died — but the work
 *   itself is untouched. This is functionally identical to what `cw session stop`
 *   already does on purpose: end the process, leave the session `idle` and
 *   resumable. Marking this `dead` instead would make a routine daemon restart
 *   permanently destroy any session that merely happened to be `running` at that
 *   moment — the same class of bug as M1's boot-gc Critical #2.
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

      if (worktreeGone) {
        sessions.updateStatus(session.id, 'dead', null);
        leases.release(session.id);
      } else if (pidGone) {
        // Same outcome as `session.stop`: process ended, work stays resumable.
        sessions.updateStatus(session.id, 'idle', null);
        leases.release(session.id);
      }
    }
  }
}
