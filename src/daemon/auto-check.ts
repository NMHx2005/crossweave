import { CrossweaveError } from '../core/errors.js';
import type { TreeOutcome } from './checkpoint-trigger.js';

export interface AutoCheckDeps {
  /** The user's `checks.autoRun`, read each time so a switch takes effect without a restart. */
  enabled(): boolean;
  /** Starts the session's trusted check (the `session.check` path). Throws a `CrossweaveError` when it cannot. */
  run(sessionId: string): void;
  log(message: string): void;
  now?(): number;
}

export interface AutoChecker {
  /** A recognised agent's turn ended; `tree` says whether it changed anything, `to` how it ended. */
  turnEnded(sessionId: string, tree: TreeOutcome, to: 'idle' | 'asked'): void;
  /** Some check (automatic or manual) is no longer running: a run that had to wait can start. */
  checkFinished(sessionId: string): void;
}

/** Normal states, not faults: nothing configured or trusted, a session that is gone or has no folder. */
/** A run is cut off at 10 minutes (checks.ts); one that never reported back after this long no longer holds the slot. */
const SLOT_MAX_MS = 15 * 60_000;

const QUIET = new Set(['CHECK_NOT_CONFIGURED', 'CHECK_UNTRUSTED', 'SESSION_NO_WORKDIR', 'SESSION_NOT_RUNNING']);

/**
 * Decides when the project's trusted test command runs on its own. A session is *owed* a run once a turn ended having changed (or
 * possibly changed) its tree; the run starts at a turn end that is not a question, because `working → asked` is also what a
 * permission prompt looks like and tests on half-finished edits would be wasted — and, with one run at a time, would swallow the
 * real final one. Only ONE automatic run goes at a time across the daemon (the machine is shared); a session that has to wait, or whose
 * own check is already running (a manual one), stays owed and is retried whenever a check finishes. Nothing here throws: this runs
 * inside the status sweep.
 */
export function createAutoChecker(deps: AutoCheckDeps): AutoChecker {
  const owed = new Set<string>();
  const active = new Map<string, number>();
  const now = (): number => deps.now?.() ?? Date.now();

  const on = (): boolean => {
    try { return deps.enabled(); } catch { return false; }
  };

  function pump(skip?: string): void {
    if (!on()) { owed.clear(); return; }
    for (const [id, since] of active) if (now() - since > SLOT_MAX_MS) active.delete(id);
    if (active.size > 0) return;
    for (const id of [...owed]) {
      if (id === skip) continue;
      try {
        deps.run(id);
        owed.delete(id);
        active.set(id, now());
        return;
      } catch (err) {
        // That session already has a run: keep it owed, the finish of that run pumps again.
        if (err instanceof CrossweaveError && err.code === 'CHECK_RUNNING') continue;
        owed.delete(id);
        if (!(err instanceof CrossweaveError && QUIET.has(err.code))) {
          deps.log(`automatic check for ${id} not started: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  return {
    turnEnded(sessionId, tree, to) {
      if (!on()) { owed.clear(); return; }
      if (tree !== 'unchanged') owed.add(sessionId);
      pump(to === 'asked' ? sessionId : undefined);
    },
    checkFinished(sessionId) {
      active.delete(sessionId);
      pump();
    },
  };
}
