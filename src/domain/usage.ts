import type { SessionRepo } from '../db/repositories/session.js';

export interface RecordUsageDeps {
  sessions: SessionRepo;
}

export interface RecordUsageParams {
  sessionId: string;
  /** Cumulative, not a delta — both usage sources report a running total (design doc §2). */
  tokensUsed?: number;
  /** Cumulative, not a delta. Not authoritative billing data — a client-side estimate. */
  costUsd?: number;
}

/**
 * The one place both usage sources — Claude Code's statusLine (via the
 * session.reportUsage RPC, Task 3) and ACP's usage_update (via AcpAdapter, in-process,
 * Task 5) — funnel through, mirroring decideBlocked's (src/radar/decision.ts)
 * established M5a/M5b shape: one plain function, two callers, one policy defined once.
 * An unknown sessionId is a silent no-op (SessionRepo.updateUsage's own contract) —
 * usage reporting is best-effort observability, not a safety decision, so it must
 * never throw and break the caller's hot path.
 */
export function recordUsage(deps: RecordUsageDeps, params: RecordUsageParams): void {
  deps.sessions.updateUsage(params.sessionId, {
    tokensSpent: params.tokensUsed,
    costSpentUsd: params.costUsd,
  });
}
