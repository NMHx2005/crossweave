import { overlapPairs, type Overlap, type SessionPaths } from '../domain/overlap.js';
import type { RepoScan } from './repo-scan.js';

export type { Overlap };

/**
 * Which sessions touch the same paths, refreshed in the background and served from
 * memory — the same shape as `GitCounter`, and for the same reason: `session.list`
 * runs on every redraw. Reads only, never a stop: the hard verdict stays the trial
 * merge, this is the early warning that arrives while the work is still cheap to move.
 */
export class OverlapTracker {
  private overlaps = new Map<string, Overlap[]>();
  private lastRun = -Infinity;
  private running = false;
  private consecutiveFailures = new Map<string, number>();

  constructor(
    private readonly read: (folder: string, baseHead: string | null) => Promise<RepoScan | null>,
    private readonly now: () => number = Date.now,
    private readonly minIntervalMs = 5000,
    /**
     * How many refreshes in a row one target's git read may fail before it alone is
     * dropped from the picture, rather than the whole refresh being abandoned every
     * time (see the docstring below). Bounds a permanently broken worktree (corrupted
     * `.git`, a permission error) to a few stale ticks instead of freezing every
     * session's badge forever waiting for a read that will never come back.
     */
    private readonly maxConsecutiveFailures = 3,
  ) {}

  get(sessionId: string): Overlap[] | undefined {
    return this.overlaps.get(sessionId);
  }

  /**
   * Resolves true when the overlap picture changed; false when skipped or unchanged.
   * Only worktree sessions should be passed (a shared session has no branch of its own
   * and a plain folder has no git).
   *
   * A folder's git read failing once or twice abandons the whole refresh and keeps the
   * previous picture: dropping the unreadable session immediately would silently remove
   * it from every peer's overlap set for a tick, flickering a badge off over a transient
   * read failure. Once a folder fails `maxConsecutiveFailures` refreshes in a row, it is
   * excluded on its own instead — everyone else keeps updating rather than staying stuck
   * on the last good picture forever.
   */
  async refresh(
    targets: () => ReadonlyArray<{ id: string; name: string; folder: string; baseHead: string | null }>,
  ): Promise<boolean> {
    if (this.running || this.now() - this.lastRun < this.minIntervalMs) return false;
    this.running = true;
    this.lastRun = this.now();
    try {
      const list = targets();
      const listedIds = new Set(list.map((t) => t.id));
      for (const id of this.consecutiveFailures.keys()) {
        if (!listedIds.has(id)) this.consecutiveFailures.delete(id);
      }

      const paths: SessionPaths[] = [];
      const idByName = new Map<string, string>();
      for (const target of list) {
        const scan = await this.read(target.folder, target.baseHead);
        if (scan === null) {
          const failures = (this.consecutiveFailures.get(target.id) ?? 0) + 1;
          this.consecutiveFailures.set(target.id, failures);
          if (failures < this.maxConsecutiveFailures) return false;
          continue;
        }
        this.consecutiveFailures.delete(target.id);
        paths.push({ name: target.name, paths: [...scan.changedPaths, ...scan.committedPaths] });
        idByName.set(target.name, target.id);
      }
      const next = new Map<string, Overlap[]>();
      for (const [name, overlaps] of overlapPairs(paths)) {
        const id = idByName.get(name);
        if (id !== undefined) next.set(id, overlaps);
      }
      const changed = !sameOverlaps(this.overlaps, next);
      this.overlaps = next;
      return changed;
    } finally {
      this.running = false;
    }
  }
}

function sameOverlaps(a: Map<string, Overlap[]>, b: Map<string, Overlap[]>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, overlaps] of a) {
    const other = b.get(id);
    if (other === undefined || JSON.stringify(overlaps) !== JSON.stringify(other)) return false;
  }
  return true;
}
