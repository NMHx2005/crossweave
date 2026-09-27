import { execFile } from 'node:child_process';

/** What the rail shows for a session's folder: files not yet committed, commits not yet landed. */
export type GitCounts = { changed: number; ahead: number | null };

/**
 * Changed paths in `git status --porcelain` output (one per line, renames included
 * once). crossweave's own `.crossweave/` — the state and the worktrees, untracked in
 * the project folder unless the user ignores it — is not the user's change: a shared
 * session showed "1 file changed" the moment it was created.
 */
export function countChanged(porcelain: string): number {
  return porcelain.split('\n').filter((line) => {
    if (line.trim() === '') return false;
    const path = line.slice(3).replace(/^"/, '');
    return path !== '.crossweave/' && !path.startsWith('.crossweave/');
  }).length;
}

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

/**
 * The counts for one folder. `baseHead` null (or a shared session, which IS the base)
 * leaves `ahead` unknown rather than guessing: a session in the project folder has
 * nothing to land, only uncommitted files.
 */
export async function readGitCounts(folder: string, baseHead: string | null): Promise<GitCounts | null> {
  const status = await git(folder, ['status', '--porcelain']);
  if (status === null) return null;
  let ahead: number | null = null;
  if (baseHead !== null) {
    const out = await git(folder, ['rev-list', '--count', `${baseHead}..HEAD`]);
    const n = out === null ? NaN : Number(out.trim());
    ahead = Number.isInteger(n) ? n : null;
  }
  return { changed: countChanged(status), ahead };
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
