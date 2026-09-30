import { CrossweaveError } from '../core/errors.js';
import { newId } from '../core/ids.js';
import type { AgentProcess } from '../adapters/types.js';
import type { SessionRow } from '../db/repositories/session.js';
import type { MethodContext } from './server.js';
import { OutputCoalescer } from './output-coalescer.js';
import { existsSync } from 'node:fs';
import type { TerminalRepo, TerminalRow } from '../db/repositories/terminal.js';
import { prepareSnapshot, restoreScrollback } from './terminal-snapshot.js';
import { daemonLog } from '../core/log.js';

/** Same budget as a session's replay: enough to redraw a screen or two. */
const SCROLLBACK_LIMIT = 64 * 1024;

/** How long a shell gets to honour SIGHUP before SIGKILL. */
const CLOSE_GRACE_MS = 2000;

export interface TerminalInfo {
  terminalId: string;
  sessionId: string;
  sessionName: string;
  workspaceId: string;
  /** Reopened after a daemon restart: a new shell, with the previous one's output above it. */
  restored?: boolean;
}

/** Keeping terminals across a daemon restart: opt-in, so every use asks `enabled()` afresh. */
export interface PersistDeps {
  enabled(): boolean;
  repo: TerminalRepo;
  /** Called whenever persistence is on and something is about to be written: keep the files private. */
  harden?(): void;
  now?(): Date;
  /** How often changed terminals are snapshotted; 30 s. */
  flushMs?: number;
  clock?: { setInterval(fn: () => void, ms: number): unknown; clearInterval(handle: unknown): void };
}

const DEFAULT_FLUSH_MS = 30_000;
const RESTORE_NOTE = 'A new shell: the previous one ended when the daemon stopped. Its earlier output is above.';

interface OpenTerminal extends TerminalInfo {
  proc: AgentProcess;
  scrollback: string;
  subscribers: Set<MethodContext>;
  /** Merges a burst of output per subscriber; the scrollback stays synchronous. */
  out: OutputCoalescer<MethodContext>;
  exited: Promise<void>;
  /** Output has arrived since the last snapshot. */
  dirty: boolean;
  restored: boolean;
}

function notifyAll(subscribers: Iterable<MethodContext>, method: string, params: unknown): void {
  for (const sub of subscribers) {
    try {
      sub.notify(method, params);
    } catch {
      // One broken subscriber must not starve the others.
    }
  }
}

/**
 * Shells opened in a session's worktree — the Terminal pane. A session's process IS
 * its agent, so when the agent exits there is no shell underneath (unlike a tmux
 * pane); this is the separate shell a person asked for.
 *
 * Ephemeral by design: nothing is stored. A terminal ends when its shell exits, when
 * it is closed, when its session's worktree is about to be removed
 * (`closeForSession`), or with the daemon (`closeAll`).
 */
export class TerminalRegistry {
  private readonly open_ = new Map<string, OpenTerminal>();

  constructor(
    private readonly spawnShell: (session: SessionRow, terminalId: string) => AgentProcess,
    /** Called whenever the set of terminals changes, so clients can redraw. */
    private readonly onChange?: () => void,
    private readonly persist?: PersistDeps,
  ) {}

  /** True while the daemon is going down: terminals ending then are kept for the next start. */
  private shuttingDown = false;
  private flushTimer: unknown;
  /** The periodic flush says once that it cannot write; it would otherwise repeat every tick. */
  private flushFailureLogged = false;

  open(session: SessionRow): TerminalInfo {
    const terminalId = newId('t');
    const info = this.launch(session, terminalId, undefined);
    if (this.persist?.enabled() === true) {
      this.persist.harden?.();
      this.persist.repo.insert({ id: terminalId, workspaceId: session.workspaceId, sessionId: session.id, createdAt: this.now().toISOString() });
    }
    return info;
  }

  /**
   * Reopen the terminals a previous daemon left: the SAME id (the cockpit's saved layout names it),
   * a new shell, the old output replayed above it. One whose session or worktree has gone is
   * dropped, row and all. Returns how many came back.
   */
  restore(rows: readonly TerminalRow[], sessionOf: (sessionId: string) => SessionRow | undefined): number {
    const persist = this.persist;
    if (persist === undefined) return 0;
    if (!persist.enabled()) {
      persist.repo.deleteAll();
      return 0;
    }
    let restored = 0;
    for (const row of rows) {
      const session = sessionOf(row.sessionId);
      if (session === undefined || session.worktreePath === null || !existsSync(session.worktreePath) || this.open_.has(row.id)) {
        if (!this.open_.has(row.id)) persist.repo.delete(row.id);
        continue;
      }
      this.launch(session, row.id, restoreScrollback(row.snapshot, RESTORE_NOTE), true);
      restored += 1;
    }
    return restored;
  }

  private now(): Date {
    return this.persist?.now?.() ?? new Date();
  }

  private launch(session: SessionRow, terminalId: string, scrollback: string | undefined, restored = false): TerminalInfo {
    const proc = this.spawnShell(session, terminalId);
    let resolveExited!: () => void;
    const entry: OpenTerminal = {
      terminalId, sessionId: session.id, sessionName: session.name, workspaceId: session.workspaceId,
      proc, scrollback: scrollback ?? '', subscribers: new Set(), dirty: false, restored,
      out: new OutputCoalescer<MethodContext>({
        send: (sub, chunk) => sub.notify('terminal.data', this.payload(entry, chunk)),
      }),
      exited: new Promise<void>((r) => { resolveExited = r; }),
    };
    this.open_.set(terminalId, entry);

    proc.onData((chunk) => {
      entry.scrollback = (entry.scrollback + chunk).slice(-SCROLLBACK_LIMIT);
      entry.dirty = true;
      for (const sub of entry.subscribers) entry.out.push(sub, chunk);
    });
    proc.onExit((code) => {
      // Bookkeeping before notifying: a throwing subscriber must not leave a dead
      // shell listed (the same ordering SessionRuntime learned the hard way).
      this.open_.delete(terminalId);
      // A terminal that ended (or was closed) is gone for good; only the daemon going down keeps its row.
      if (!this.shuttingDown) this.persist?.repo.delete(terminalId);
      resolveExited();
      // Pending output first: the exit must not overtake the last bytes.
      entry.out.flushAll();
      notifyAll(entry.subscribers, 'terminal.exit', { terminalId, code });
      this.onChange?.();
    });

    this.startFlushing();
    this.onChange?.();
    return this.info(entry);
  }

  list(workspaceId: string): TerminalInfo[] {
    return [...this.open_.values()].filter((t) => t.workspaceId === workspaceId).map((t) => this.info(t));
  }

  subscribe(terminalId: string, ctx: MethodContext): TerminalInfo {
    const entry = this.require(terminalId);
    if (!entry.subscribers.has(ctx)) {
      entry.subscribers.add(ctx);
      ctx.onClose(() => {
        entry.subscribers.delete(ctx);
        entry.out.clear(ctx);
      });
    }
    // Before the replay, on a re-attach too: the scrollback already holds whatever this
    // ctx had pending, so a later timer flush would print it a second time.
    entry.out.clear(ctx);
    if (entry.scrollback.length > 0) {
      const payload = this.payload(entry, entry.scrollback);
      if (payload !== undefined) ctx.notify('terminal.data', payload);
    }
    return this.info(entry);
  }

  write(terminalId: string, data: string): void {
    this.require(terminalId).proc.write(data);
  }

  resize(terminalId: string, cols: number, rows: number): void {
    this.require(terminalId).proc.resize(cols, rows);
  }

  /** Hang up the shell and wait until it is gone, escalating if it ignores SIGHUP. */
  async close(terminalId: string): Promise<void> {
    const entry = this.require(terminalId);
    entry.proc.kill('SIGHUP');
    const timer = setTimeout(() => entry.proc.kill('SIGKILL'), CLOSE_GRACE_MS);
    await entry.exited;
    clearTimeout(timer);
  }

  /** How many extra terminals are open right now. */
  count(): number {
    return this.open_.size;
  }

  async closeForSession(sessionId: string): Promise<void> {
    const ids = [...this.open_.values()].filter((t) => t.sessionId === sessionId).map((t) => t.terminalId);
    await Promise.all(ids.map((id) => this.close(id)));
    // Whether or not a shell was still running: the session's snapshots must not outlive it.
    this.persist?.repo.deleteBySession(sessionId);
  }

  async closeAll(): Promise<void> {
    // Going down: snapshot everything, then let the shells end WITHOUT losing their rows, so the
    // next daemon reopens them.
    if (this.persist?.enabled() === true) this.flush(true);
    this.shuttingDown = true;
    this.stopFlushing();
    try {
      await Promise.all([...this.open_.keys()].map((id) => this.close(id)));
    } finally {
      this.shuttingDown = false;
    }
  }

  /** Save the output of every terminal that changed (all of them when `force`). Off: forget everything stored. */
  flush(force = false): void {
    const persist = this.persist;
    if (persist === undefined) return;
    if (!persist.enabled()) {
      persist.repo.deleteAll();
      return;
    }
    persist.harden?.();
    const at = this.now().toISOString();
    for (const t of this.open_.values()) {
      if (!t.dirty && !force) continue;
      persist.repo.setSnapshot(t.terminalId, prepareSnapshot(t.scrollback), at);
      t.dirty = false;
    }
  }

  private startFlushing(): void {
    const persist = this.persist;
    if (persist === undefined || this.flushTimer !== undefined) return;
    const clock = persist.clock ?? {
      setInterval: (fn: () => void, ms: number) => { const h = setInterval(fn, ms); h.unref?.(); return h; },
      clearInterval: (h: unknown) => clearInterval(h as ReturnType<typeof setInterval>),
    };
    // A timer callback has no caller to handle an error: whatever the database does (it is closed while the daemon goes
    // down, and a test closes it under a live registry), nothing may escape from here as an uncaught exception.
    this.flushTimer = clock.setInterval(() => {
      try {
        this.flush();
      } catch (err) {
        if (!this.flushFailureLogged) {
          this.flushFailureLogged = true;
          daemonLog(`could not save terminal output: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }, persist.flushMs ?? DEFAULT_FLUSH_MS);
  }

  private stopFlushing(): void {
    const persist = this.persist;
    if (this.flushTimer === undefined || persist === undefined) return;
    const clock = persist.clock ?? { clearInterval: (h: unknown) => clearInterval(h as ReturnType<typeof setInterval>) };
    clock.clearInterval(this.flushTimer);
    this.flushTimer = undefined;
  }

  private require(terminalId: string): OpenTerminal {
    const entry = this.open_.get(terminalId);
    if (entry === undefined) throw new CrossweaveError('TERMINAL_NOT_FOUND', `No such terminal: ${terminalId}`);
    return entry;
  }

  private info(t: OpenTerminal): TerminalInfo {
    return { terminalId: t.terminalId, sessionId: t.sessionId, sessionName: t.sessionName, workspaceId: t.workspaceId, ...(t.restored ? { restored: true } : {}) };
  }

  private payload(t: OpenTerminal, chunk: string): Record<string, unknown> {
    return { terminalId: t.terminalId, sessionId: t.sessionId, workspaceId: t.workspaceId, chunk };
  }
}
