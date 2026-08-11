import type { FileClaimRepo } from '../db/repositories/file-claim.js';
import type { MessageBus } from '../domain/bus.js';
import { checkCollisions } from './collisions.js';
import type { NotificationGate } from './noise.js';

export interface RetroNotifyOpts {
  workspaceId: string;
  sessionId: string;
}

/**
 * After a reindex, tells every OTHER session with a genuinely divergent
 * claim about this session's changes — the "everyone else" delivery path
 * from the M3 design doc §5, reaching sessions with no `PreToolUse` hook to
 * ask `radar.check` on their behalf. Rate-limited/coalesced through `gate`,
 * exactly like the hook's own advisory (Task 9) — see Task 7's noise-control
 * scope note in this plan for why this path is filtered but
 * `radar.check`/`cw_check` are not.
 */
export function notifyCollisions(
  claims: FileClaimRepo,
  bus: MessageBus,
  gate: NotificationGate,
  opts: RetroNotifyOpts,
): void {
  for (const claim of claims.listBySession(opts.sessionId)) {
    const collisions = checkCollisions(claims, {
      workspaceId: opts.workspaceId,
      sessionId: opts.sessionId,
      path: claim.path,
      symbol: claim.symbol ?? undefined,
    });
    for (const collision of collisions) {
      if (!gate.shouldNotify(collision.sessionId, collision.path, collision.symbol)) continue;
      bus.send({
        workspaceId: opts.workspaceId,
        fromSession: opts.sessionId,
        toSession: collision.sessionId,
        trust: 'system',
        body:
          `crossweave Radar: session ${opts.sessionId} also has divergent changes to ${collision.path}` +
          `${collision.symbol ? ` (${collision.symbol})` : ''}.`,
      });
    }
  }
}
