import type { FileClaimRepo } from '../db/repositories/file-claim.js';
import type { WorkspaceManager } from '../domain/workspace.js';
import type { SessionManager } from '../domain/session.js';
import { checkCollisions, type Collision } from './collisions.js';

export interface DecideBlockedDeps {
  fileClaims: FileClaimRepo;
  workspaces: WorkspaceManager;
  sessions: SessionManager;
}

export interface DecideBlockedParams {
  workspaceId: string;
  sessionId: string;
  path: string;
  symbol?: string;
}

export interface DecideBlockedResult {
  collisions: Collision[];
  blocked: boolean;
}

/**
 * The blocking policy — workspace floor x this session's own capability x whether a
 * collision even exists — lives here, exactly once, so every caller gets the identical
 * decision: the Claude Code PreToolUse hook via `radar.check` (src/daemon/methods.ts),
 * and M5b's in-process ACP permission handler (src/adapters/acp.ts). Extracted verbatim
 * from radar.check's M5a implementation — no behavior change.
 */
export function decideBlocked(deps: DecideBlockedDeps, params: DecideBlockedParams): DecideBlockedResult {
  const collisions = checkCollisions(deps.fileClaims, {
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    path: params.path,
    symbol: params.symbol,
  });
  const safeModeTier = deps.workspaces.resolve(params.workspaceId).safeModeTier;
  const enforcementTier = deps.sessions.resolve(params.workspaceId, params.sessionId).enforcementTier;
  const blocked = safeModeTier !== 'T3' && enforcementTier !== 'T3' && collisions.length > 0;
  return { collisions, blocked };
}
