import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 6;

/**
 * Governs UNPROMPTED notifications only (hook advisories, retroactive inbox
 * notices) — never `radar.check`/`cw_check`'s own direct answer. See this
 * task's header note for the full reasoning.
 *
 * In-memory, per daemon process: resets on restart, consistent with this
 * project's existing posture on process-lifetime state (the daemon's
 * `starting` set, `LeaseManager`'s in-memory tracking before M1's disk
 * guard). `clock` is injectable so tests never depend on real elapsed time.
 */
export class NotificationGate {
  private readonly sent = new Map<string, number[]>(); // sessionId -> timestamps
  private readonly coalesced = new Map<string, number>(); // `${sessionId}\0${path}\0${symbol}` -> last-sent ts

  constructor(private readonly clock: () => number = () => Date.now()) {}

  shouldNotify(sessionId: string, path: string, symbol: string | null): boolean {
    const now = this.clock();
    const coalesceKey = `${sessionId}\0${path}\0${symbol}`;
    if (this.coalesced.has(coalesceKey)) return false;

    const timestamps = (this.sent.get(sessionId) ?? []).filter((t) => now - t < WINDOW_MS);
    if (timestamps.length >= MAX_PER_WINDOW) {
      this.sent.set(sessionId, timestamps);
      return false;
    }

    timestamps.push(now);
    this.sent.set(sessionId, timestamps);
    this.coalesced.set(coalesceKey, now);
    return true;
  }
}

/**
 * Cheap approximation of "does this session care about `symbolName`": a
 * ripgrep search for the identifier across the session's own touched files.
 * Deliberately not a real import graph (see the M3 design doc §5/§9) —
 * tuned to over-notify rather than silently miss. Returns `false` (not an
 * error) if `rg` is unavailable, so a session without ripgrep on PATH simply
 * never gets reference-scoped notifications rather than crashing.
 */
export function references(worktreePath: string, touchedFiles: string[], symbolName: string): boolean {
  if (touchedFiles.length === 0) return false;
  try {
    execFileSync(
      'rg', ['-l', '--fixed-strings', symbolName, ...touchedFiles.map((f) => join(worktreePath, f))],
      { cwd: worktreePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return true; // exit 0 — at least one match
  } catch (err) {
    // exit 1 = no match (not an error condition); anything else (rg missing, etc.) also degrades to false.
    return false;
  }
}
