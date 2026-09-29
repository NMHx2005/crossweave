import { readRepoScan } from './repo-scan.js';

/** What the rail shows for a session's folder: files not yet committed, commits not yet landed. */
export type GitCounts = { changed: number; ahead: number | null };

// Re-exported (not duplicated) so the many readers of `countChanged` keep importing it
// from here, while the status parsing itself lives with the rest of the folder scan.
export { countChanged } from './repo-scan.js';

/**
 * The counts for one folder. `baseHead` null (or a shared session, which IS the base)
 * leaves `ahead` unknown rather than guessing: a session in the project folder has
 * nothing to land, only uncommitted files.
 */
export async function readGitCounts(folder: string, baseHead: string | null): Promise<GitCounts | null> {
  const scan = await readRepoScan(folder, baseHead);
  return scan === null ? null : { changed: scan.changed, ahead: scan.ahead };
}

/**
 * Counts per session, read in the background and served from memory: `session.list`
 * is called on every redraw, and two git processes per session per call would make
 * the rail's speed depend on the size of every worktree. A refresh is asked for on
 * each list, runs at most once per `minIntervalMs`, and reports whether anything
 * changed so the daemon can tell clients to redraw.
 */
export class GitCounter {
  private readonly counts = new Map<string, GitCounts>();
  private lastRun = -Infinity;
  private running = false;

  constructor(
    private readonly read: (folder: string, baseHead: string | null) => Promise<GitCounts | null> = readGitCounts,
    private readonly now: () => number = Date.now,
    private readonly minIntervalMs = 3000,
  ) {}

  get(sessionId: string): GitCounts | undefined {
    return this.counts.get(sessionId);
  }

  /** A read now, stored, ignoring the throttle: for a caller that needs the counts as of this moment. */
  async readNow(sessionId: string, folder: string, baseHead: string | null): Promise<GitCounts | null> {
    const next = await this.read(folder, baseHead);
    if (next === null) this.counts.delete(sessionId);
    else this.counts.set(sessionId, next);
    return next;
  }

  /**
   * Resolves true when some session's counts changed; false when skipped or unchanged.
   * `targets` is only called when a read is due, so what it costs is throttled too.
   */
  async refresh(targets: () => ReadonlyArray<{ id: string; folder: string; baseHead: string | null }>): Promise<boolean> {
    if (this.running || this.now() - this.lastRun < this.minIntervalMs) return false;
    this.running = true;
    this.lastRun = this.now();
    try {
      const list = targets();
      let changed = false;
      const live = new Set(list.map((t) => t.id));
      for (const id of [...this.counts.keys()]) {
        if (!live.has(id)) {
          this.counts.delete(id);
          changed = true;
        }
      }
      for (const target of list) {
        const next = await this.read(target.folder, target.baseHead);
        const prev = this.counts.get(target.id);
        if (next === null) {
          if (prev !== undefined) {
            this.counts.delete(target.id);
            changed = true;
          }
          continue;
        }
        if (prev?.changed !== next.changed || prev?.ahead !== next.ahead) {
          this.counts.set(target.id, next);
          changed = true;
        }
      }
      return changed;
    } finally {
      this.running = false;
    }
  }
}
