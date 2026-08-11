import type { Database } from 'bun:sqlite';
import { watch, type FSWatcher } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RadarIndexer, type IndexableSession } from '../radar/indexer.js';
import { createDebouncer } from '../radar/watch-debounce.js';
import { FileClaimRepo } from '../db/repositories/file-claim.js';
import { NotificationGate } from '../radar/noise.js';
import { notifyCollisions } from '../radar/retro-notify.js';
import type { MessageBus } from '../domain/bus.js';
import type { ContractService } from '../radar/contracts.js';

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
 */
export class RadarWatcherRegistry {
  private readonly indexer: RadarIndexer;
  private readonly claims: FileClaimRepo;
  private readonly gate = new NotificationGate();
  private readonly watchers = new Map<string, { fsWatcher: FSWatcher; debouncer: ReturnType<typeof createDebouncer> }>();

  constructor(
    db: Database,
    private readonly bus: MessageBus,
    private readonly contracts: ContractService,
  ) {
    this.indexer = new RadarIndexer(db);
    this.claims = new FileClaimRepo(db);
  }

  /** Only sessions with their OWN worktree are watched — a shared (`--no-worktree`) session has no fork point to diff against. */
  start(session: IndexableSession): void {
    this.stop(session.id);
    const debouncer = createDebouncer(() => {
      void this.reindexAndNotify(session).catch((err: unknown) => {
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

    // `watch()`'s synchronous throw above only covers failures at open time.
    // Late failures (inotify limits, the watched root being removed, EPERM
    // appearing after the fact) arrive as an `'error'` EVENT on the
    // `FSWatcher` instead — with no listener, EventEmitter rethrows it,
    // caught only by main.ts's top-level `uncaughtException` handler with no
    // session id attached. Mirrors src/mcp/server.ts's `netServer.on('error',
    // ...)` pattern: log with the session id, then clean up the dead entry
    // so it doesn't linger in the map with a closed/broken watcher.
    fsWatcher.on('error', (err: unknown) => {
      process.stderr.write(`crossweave: worktree watcher failed for session ${session.id}: ${String(err)}\n`);
      this.stop(session.id);
    });
  }

  /**
   * The one place per debounce tick where "reindex" becomes "reindex AND
   * tell everyone who needs to know" — kept as a thin sequencing wrapper
   * (no branching logic of its own) so the three pieces it calls stay each
   * independently unit-tested (Tasks 4, 7, 8) rather than needing a fourth,
   * `fs.watch`-entangled test for the combination.
   */
  private async reindexAndNotify(session: IndexableSession): Promise<void> {
    await this.indexer.reindexSession(session);
    notifyCollisions(this.claims, this.bus, this.gate, {
      workspaceId: session.workspaceId, sessionId: session.id,
    });

    // Nothing declared in this workspace — skip the file-read-and-check
    // sweep entirely rather than opening every changed file for nothing.
    if (!this.contracts.hasContracts(session.workspaceId)) return;

    const paths = new Set(this.claims.listBySession(session.id).map((c) => c.path));
    for (const path of paths) {
      let source: string;
      try {
        source = readFileSync(join(session.worktreePath, path), 'utf8');
      } catch {
        continue; // deleted since the reindex read it — skip this pass
      }
      // A claim on this path is this session's evidence of "cares about
      // this file" — auto-subscribe it to any contract living there before
      // checking, so a signature change caught THIS pass still reaches it.
      this.contracts.autoSubscribeForPath(session.workspaceId, session.id, path);
      this.contracts.checkAndNotify(session.workspaceId, path, source, this.bus, session.id);
    }
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
