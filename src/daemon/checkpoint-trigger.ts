import { CrossweaveError } from '../core/errors.js';
import type { CheckpointContext } from '../domain/checkpoint.js';
import type { Activity } from './session-status.js';

export type AutoCheckpointKind = 'start' | 'turn';

/** What a turn did to the tree, as the checkpoint dedupe saw it: `unknown` when the take failed (it may have changed). */
export type TreeOutcome = 'changed' | 'unchanged' | 'unknown';

/**
 * Which checkpoint, if any, a status move calls for. `→ working` is the agent starting — the last chance to save the
 * "before", including the person's own edits made between turns; `working → idle|asked` is its turn ending. A failure
 * takes nothing: the shell broke, no turn finished. Two per turn is deliberate; the dedupe in the domain makes the
 * start one free when nothing changed since the last turn ended.
 */
export function checkpointKindFor(from: Activity, to: Activity): AutoCheckpointKind | null {
  if (from === 'working' && (to === 'idle' || to === 'asked')) return 'turn';
  if (from !== 'working' && to === 'working') return 'start';
  return null;
}

export interface AutoCheckpointDeps {
  /** The agent running in the session (or one of its panes), or null for a plain shell. */
  agentOf(sessionId: string): string | null;
  isWorking(sessionId: string): boolean;
  /** The session's checkpoint context, or null when it is gone or has no worktree of its own. */
  contextFor(sessionId: string): CheckpointContext | null;
  take(ctx: CheckpointContext, kind: AutoCheckpointKind): Promise<unknown>;
  /**
   * A recognised agent's turn ended and its checkpoint was attempted. Never called for a `start`, a plain shell, or a session with
   * no checkpoints at all (no worktree of its own): there is no change detection there, so nothing could tell a chat-only turn
   * from an editing one.
   */
  turnEnded?(sessionId: string, tree: TreeOutcome, asking: boolean): void;
  /** The session is waiting for the person (a permission prompt, a question, a bell) rather than finished. Read when a turn ends. */
  isAsking?(sessionId: string): boolean;
  log(message: string): void;
}

export interface AutoCheckpointer {
  /** Called by the status sweep on every move. */
  onChange(sessionId: string, from: Activity, to: Activity): Promise<void>;
  /** Called after each sweep: pays a start checkpoint that was owed because the agent was not visible yet. */
  poll(): Promise<void>;
}

/**
 * What the status sweep calls. It never throws, so a vanished worktree or a full disk is a log line, not an error that
 * would stop every other session's status. Only sessions with a recognised agent count — a plain shell reaches
 * `working` on any output (an `ls`, a dev server's logs), and none of that is a turn.
 *
 * The output that turns a session `working` can arrive before `ps` sees the agent process start. Dropping the start
 * checkpoint then would lose exactly the first turn's "before", so it is remembered as owed and taken at the first
 * `poll` where the agent shows up and the session is still working.
 */
export function createAutoCheckpointer(deps: AutoCheckpointDeps): AutoCheckpointer {
  const owed = new Set<string>();

  async function take(sessionId: string, kind: AutoCheckpointKind): Promise<TreeOutcome | 'none'> {
    try {
      const ctx = deps.contextFor(sessionId);
      if (ctx === null) return 'none';
      const created = ((await deps.take(ctx, kind)) as { created?: unknown } | null | undefined)?.created;
      return created === true ? 'changed' : created === false ? 'unchanged' : 'unknown';
    } catch (err) {
      deps.log(`checkpoint (${kind}) for ${sessionId} skipped: ${err instanceof Error ? err.message : String(err)}`);
      return 'unknown';
    }
  }

  return {
    async onChange(sessionId, from, to) {
      const kind = checkpointKindFor(from, to);
      if (kind === null) return;
      if (kind === 'turn') owed.delete(sessionId);
      if (deps.agentOf(sessionId) === null) {
        if (kind === 'start') owed.add(sessionId);
        return;
      }
      const tree = await take(sessionId, kind);
      if (kind !== 'turn' || tree === 'none') return;
      try {
        deps.turnEnded?.(sessionId, tree, deps.isAsking?.(sessionId) === true);
      } catch (err) {
        deps.log(`turn-ended listener for ${sessionId} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    async poll() {
      for (const sessionId of [...owed]) {
        if (!deps.isWorking(sessionId)) { owed.delete(sessionId); continue; }
        if (deps.agentOf(sessionId) === null) continue;
        owed.delete(sessionId);
        await take(sessionId, 'start');
      }
    },
  };
}

/** The status is inferred, so a person who knows better has `force`. */
export function assertNotBusy(sessionName: string, activity: Activity, force: boolean): void {
  if (activity === 'working' && !force) {
    throw new CrossweaveError('CHECKPOINT_SESSION_BUSY', `${sessionName} looks busy; restoring files under a running agent can fight it. Retry with force.`);
  }
}
