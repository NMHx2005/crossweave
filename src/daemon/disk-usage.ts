import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface DiskEntry {
  name: string;
  /** `other` covers symlinks, sockets and the rest: never followed, never counted. */
  kind: 'dir' | 'file' | 'other';
}

/** The two filesystem calls a walk needs, so it can be driven by a fake. */
export interface DiskFs {
  readdir(path: string): Promise<DiskEntry[]>;
  /** Size in bytes of a file itself (a symlink is not followed). */
  fileSize(path: string): Promise<number>;
}

const realFs: DiskFs = {
  async readdir(path) {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((e): DiskEntry => ({
      name: e.name,
      // Links first: a link to a directory must not be walked (it could loop, or leave the tree).
      kind: e.isSymbolicLink() ? 'other' : e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other',
    }));
  },
  async fileSize(path) {
    return (await lstat(path)).size;
  },
};

export interface Measured {
  bytes: number;
  /** A lower bound: the walk hit its deadline, or something in the tree could not be read. */
  approx: boolean;
  /** When it was measured, ms since the epoch. */
  at: number;
}

export interface DiskDeps {
  fs?: DiskFs;
  now?: () => number;
  /** How long a figure is served without walking again. */
  ttlMs?: number;
  /** How long one walk may run before it returns what it has, flagged as a lower bound. */
  deadlineMs?: number;
  /** Directory reads in flight at once. */
  concurrency?: number;
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_DEADLINE_MS = 8_000;
const DEFAULT_CONCURRENCY = 8;
/** Files sized at once inside one directory, so a directory of 100k files does not open 100k lstat calls together. */
const FILE_BATCH = 64;

const codeOf = (err: unknown): string | undefined => (typeof err === 'object' && err !== null ? (err as { code?: string }).code : undefined);
/** A directory or file that is simply not there any more (an agent deleting files while we walk): not a problem. */
const isGone = (err: unknown): boolean => codeOf(err) === 'ENOENT' || codeOf(err) === 'ENOTDIR';
const wholeBytes = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/**
 * How much disk a directory holds, measured WITHOUT freezing the daemon. The old `directorySize` is one synchronous
 * recursive walk: on a checkout with `node_modules` it blocks every other request for seconds, and `workspace.info` ran it
 * on the RPC path. This walk is asynchronous (every directory read yields to the event loop), bounded in concurrency,
 * given a deadline, and cached: one walk per path at a time, a figure served for `ttlMs`, stale figures still readable so
 * a screen can show the last known number while a fresh one is measured.
 *
 * It never throws. What it cannot read (permissions) or cannot finish (the deadline) makes the figure a lower bound, said
 * so by `approx`; what vanished mid-walk counts as zero. Symlinks are never followed: a loop cannot trap it and a link
 * out of the tree is not this tree's disk.
 */
export class DiskTracker {
  private readonly fs: DiskFs;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly deadlineMs: number;
  private readonly concurrency: number;
  private readonly cache = new Map<string, Measured>();
  private readonly inflight = new Map<string, Promise<Measured>>();

  constructor(deps: DiskDeps = {}) {
    this.fs = deps.fs ?? realFs;
    this.now = deps.now ?? Date.now;
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
    this.deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;
    this.concurrency = Math.max(1, deps.concurrency ?? DEFAULT_CONCURRENCY);
  }

  /** The last figure for `path`, however old; undefined if it was never measured. */
  get(path: string): Measured | undefined {
    return this.cache.get(path);
  }

  forget(path: string): void {
    this.cache.delete(path);
  }

  /** Forget every figure (after something that changed a lot of disk at once, like a gc). Walks in flight finish and re-fill. */
  clear(): void {
    this.cache.clear();
  }

  /**
   * The figure for `path`: fresh from the cache, shared with a walk already running, or a new walk. `maxAgeMs` lets a caller
   * that needs fresher numbers than the default (a CLI status line) say so.
   */
  measure(path: string, opts: { maxAgeMs?: number } = {}): Promise<Measured> {
    const cached = this.cache.get(path);
    if (cached !== undefined && this.now() - cached.at < (opts.maxAgeMs ?? this.ttlMs)) return Promise.resolve(cached);
    const running = this.inflight.get(path);
    if (running !== undefined) return running;
    const walk = this.walk(path)
      .then((result) => { this.cache.set(path, result); return result; })
      .finally(() => { this.inflight.delete(path); });
    this.inflight.set(path, walk);
    return walk;
  }

  /** Start walks for the paths that have no fresh figure; returns at once. Nothing here can reject. */
  refresh(paths: readonly string[]): void {
    for (const path of new Set(paths)) {
      const cached = this.cache.get(path);
      if (this.inflight.has(path) || (cached !== undefined && this.now() - cached.at < this.ttlMs)) continue;
      void this.measure(path).catch(() => undefined);
    }
  }

  /** Resolves when no walk is running (for callers that want to wait for what `refresh` started). */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight.values()]);
  }

  private async walk(root: string): Promise<Measured> {
    const started = this.now();
    let bytes = 0;
    let approx = false;
    let stopped = false;
    const queue: string[] = [root];
    let active = 0;

    const size = async (path: string): Promise<void> => {
      try {
        // Read the size FIRST: `bytes += await …` would read `bytes` before the await and lose the other files' additions.
        const n = wholeBytes(await this.fs.fileSize(path));
        bytes += n;
      } catch (err) {
        if (!isGone(err)) approx = true;
      }
    };

    const visit = async (dir: string): Promise<void> => {
      if (this.now() - started > this.deadlineMs) { stopped = true; approx = true; return; }
      let entries: DiskEntry[];
      try {
        entries = await this.fs.readdir(dir);
      } catch (err) {
        // The root itself may be a file (a lease can point at one): size it. Anything else that is gone counts as zero.
        if (codeOf(err) === 'ENOTDIR' && dir === root) await size(dir);
        else if (!isGone(err)) approx = true;
        return;
      }
      const files: string[] = [];
      for (const entry of entries) {
        const child = join(dir, entry.name);
        if (entry.kind === 'dir') queue.push(child);
        else if (entry.kind === 'file') files.push(child);
      }
      for (let i = 0; i < files.length; i += FILE_BATCH) {
        if (this.now() - started > this.deadlineMs) { stopped = true; approx = true; return; }
        await Promise.all(files.slice(i, i + FILE_BATCH).map(size));
      }
    };

    await new Promise<void>((resolve) => {
      const pump = (): void => {
        while (!stopped && active < this.concurrency && queue.length > 0) {
          const dir = queue.pop() as string;
          active += 1;
          void visit(dir).catch(() => { approx = true; }).finally(() => { active -= 1; pump(); });
        }
        if (active === 0 && (stopped || queue.length === 0)) resolve();
      };
      pump();
    });

    return { bytes, approx, at: this.now() };
  }
}
