import { execFile } from 'node:child_process';

/**
 * One read of a session's folder, for every per-session figure the rail shows. `git
 * status` and the two `git rev-list`/`git diff` calls are the expensive part of a
 * `session.list`, and the counters that need them (`GitCounter` for counts, the
 * `OverlapTracker` for touched paths) must not each pay for their own — so they read
 * through one `RepoScanner` and share the pass.
 */

export interface RepoScan {
  /** Same definition as the rail's git badge: non-empty status lines, minus `.crossweave/`. */
  changed: number;
  /** Commits past the base; null for a shared session (there is no base to be ahead of). */
  ahead: number | null;
  /** Paths behind `changed` — what the session has changed but not committed. */
  changedPaths: string[];
  /** Paths the session has committed since it left the base (`base...HEAD`). */
  committedPaths: string[];
}

/**
 * Changed paths in `git status --porcelain` output. crossweave's own `.crossweave/`
 * (state and worktrees) is not the user's change — a shared session showed "1 file
 * changed" the moment it was created. A rename reads `old -> new`: both ends are paths
 * the session touched, so both count.
 */
export function statusPaths(porcelain: string): string[] {
  const out = new Set<string>();
  for (const line of porcelain.split('\n')) {
    if (line.trim() === '') continue;
    const raw = line.slice(3);
    for (const part of raw.includes(' -> ') ? raw.split(' -> ') : [raw]) {
      const path = part.replace(/^"/, '').replace(/"$/, '');
      if (path === '' || path === '.crossweave' || path.startsWith('.crossweave/')) continue;
      out.add(path);
    }
  }
  return [...out].sort();
}

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
    execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

/**
 * The full scan for one folder. `null` when git cannot read it at all (not a
 * repository, or gone) — the same "unknown, not zero" the counters already rely on.
 *
 * `committedPaths` uses `baseHead...HEAD` (three-dot): the session's own changes since
 * it left the base, never the base's own later commits — the same definition
 * `session.diff` uses. It therefore shrinks as the base advances (the merge-base moves
 * forward), which is a documented limitation of the overlap signal, not a bug here.
 */
export async function readRepoScan(folder: string, baseHead: string | null): Promise<RepoScan | null> {
  const status = await git(folder, ['status', '--porcelain']);
  if (status === null) return null;
  let ahead: number | null = null;
  let committedPaths: string[] = [];
  if (baseHead !== null) {
    const count = await git(folder, ['rev-list', '--count', `${baseHead}..HEAD`]);
    const n = count === null ? NaN : Number(count.trim());
    ahead = Number.isInteger(n) ? n : null;
    const diff = await git(folder, ['diff', '--name-only', '--no-renames', `${baseHead}...HEAD`]);
    committedPaths = diff === null ? [] : diff.split('\n').filter((path) => path !== '').sort();
  }
  return { changed: countChanged(status), ahead, changedPaths: statusPaths(status), committedPaths };
}

/**
 * A short-lived cache over `readRepoScan`, so the two counters that read the same
 * folder within a tick share one set of git processes. It also caches the in-flight
 * promise: `session.list` fires both refreshes without awaiting, so unless the second
 * call finds the first one already running, it would start its own read.
 */
export class RepoScanner {
  private readonly cache = new Map<string, { at: number; scan: Promise<RepoScan | null> }>();

  constructor(
    private readonly read: (folder: string, baseHead: string | null) => Promise<RepoScan | null> = readRepoScan,
    private readonly now: () => number = Date.now,
    private readonly minIntervalMs = 2000,
    /**
     * Entries not read within this window are dropped. Without it the cache would grow
     * for the daemon's whole life: the key includes `baseHead`, which changes on every
     * commit, and folders of deleted sessions are never looked up again.
     */
    private readonly maxAgeMs = 60_000,
  ) {}

  scan(folder: string, baseHead: string | null): Promise<RepoScan | null> {
    this.prune();
    const key = `${folder}\u0000${baseHead ?? ''}`;
    const hit = this.cache.get(key);
    if (hit !== undefined && this.now() - hit.at < this.minIntervalMs) return hit.scan;
    const scan = this.read(folder, baseHead);
    this.cache.set(key, { at: this.now(), scan });
    return scan;
  }

  private prune(): void {
    const cutoff = this.now() - this.maxAgeMs;
    for (const [key, entry] of this.cache) {
      if (entry.at < cutoff) this.cache.delete(key);
    }
  }

  /** The counts half, in the shape `GitCounter`'s reader wants. */
  async counts(folder: string, baseHead: string | null): Promise<{ changed: number; ahead: number | null } | null> {
    const scan = await this.scan(folder, baseHead);
    return scan === null ? null : { changed: scan.changed, ahead: scan.ahead };
  }
}
