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

  constructor(
    private readonly read: (folder: string, baseHead: string | null) => Promise<RepoScan | null>,
    private readonly now: () => number = Date.now,
    private readonly minIntervalMs = 5000,
  ) {}

  get(sessionId: string): Overlap[] | undefined {
    return this.overlaps.get(sessionId);
  }

  /**
   * Resolves true when the overlap picture changed; false when skipped or unchanged.
   * Only worktree sessions should be passed (a shared session has no branch of its own
   * and a plain folder has no git).
   *
   * If ANY folder's git read fails, the whole refresh is abandoned and the previous
   * picture is kept: dropping just the unreadable session would silently remove it from
   * every peer's overlap set for a tick, flickering a badge off over a transient read
   * failure. The next tick retries.
   */
  async refresh(
    targets: () => ReadonlyArray<{ id: string; name: string; folder: string; baseHead: string | null }>,
  ): Promise<boolean> {
    if (this.running || this.now() - this.lastRun < this.minIntervalMs) return false;
    this.running = true;
    this.lastRun = this.now();
    try {
      const list = targets();
      const paths: SessionPaths[] = [];
      const idByName = new Map<string, string>();
      for (const target of list) {
        const scan = await this.read(target.folder, target.baseHead);
        if (scan === null) return false;
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
