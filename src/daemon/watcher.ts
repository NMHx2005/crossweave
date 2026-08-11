import type { Database } from 'bun:sqlite';
import { watch, type FSWatcher } from 'node:fs';
import { RadarIndexer, type IndexableSession } from '../radar/indexer.js';
import { createDebouncer } from '../radar/watch-debounce.js';

const DEBOUNCE_MS = 500;

/**
 * One `fs.watch` per session with its own worktree, debounced into the
 * indexer. Deliberately NOT unit-tested against a live filesystem event —
 * see this plan's Global Constraints: sandboxed dev/CI shells do not
 * reliably deliver `fs.watch` notifications even though the underlying
 * writes succeed, which would make such a test flaky for a reason that has
 * nothing to do with this code's correctness. `RadarWatcherRegistry`'s real
 * logic (Task 4's indexer, this file's debounce timer) is tested directly;
 * this class is the last few lines of OS wiring around both.
 *
 * NOTE: Task 8 replaces this class with a version that also takes `bus` and
 * `contracts` constructor arguments and notifies collisions/contract
 * changes after each reindex — this Task-5 version is this file's starting
 * point, not its final shape.
 */
export class RadarWatcherRegistry {
  private readonly indexer: RadarIndexer;
  private readonly watchers = new Map<string, { fsWatcher: FSWatcher; debouncer: ReturnType<typeof createDebouncer> }>();

  constructor(db: Database) {
    this.indexer = new RadarIndexer(db);
  }

  /** Only sessions with their OWN worktree are watched — a shared (`--no-worktree`) session has no fork point to diff against. */
  start(session: IndexableSession): void {
    this.stop(session.id);
    const debouncer = createDebouncer(() => {
      void this.indexer.reindexSession(session).catch((err: unknown) => {
        process.stderr.write(`crossweave: radar reindex failed for session ${session.id}: ${String(err)}\n`);
      });
    }, DEBOUNCE_MS);

    let fsWatcher: FSWatcher;
    try {
      fsWatcher = watch(session.worktreePath, { recursive: true }, () => debouncer.trigger());
    } catch (err) {
      // Best effort, exactly like the MCP server's bind failure: a session
      // whose worktree can't be watched still starts, just without Radar.
      process.stderr.write(`crossweave: could not watch worktree for session ${session.id}: ${String(err)}\n`);
      return;
    }
    this.watchers.set(session.id, { fsWatcher, debouncer });
  }

  stop(sessionId: string): void {
    const entry = this.watchers.get(sessionId);
    if (!entry) return;
    entry.debouncer.stop();
    entry.fsWatcher.close();
    this.watchers.delete(sessionId);
  }

  stopAll(): void {
    for (const id of [...this.watchers.keys()]) this.stop(id);
  }
}
