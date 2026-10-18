import { CrossweaveError } from '../core/errors.js';
import type { AgentAdapter, AgentProcess } from '../adapters/types.js';
import type { SessionRow } from '../db/repositories/session.js';
import type { MethodContext } from './server.js';
import { OutputCoalescer } from './output-coalescer.js';

const SCROLLBACK_LIMIT = 64 * 1024;

/** How long a session's shell gets to honour SIGHUP before SIGKILL. */
const STOP_GRACE_MS = 3000;

/**
 * One broken subscriber must not starve the others, and must never be able to stop
 * the runtime's own bookkeeping from running.
 */
function notifyAll(
  subscribers: Iterable<MethodContext>,
  method: string,
  params: unknown,
): void {
  for (const sub of subscribers) {
    try {
      sub.notify(method, params);
    } catch {
      // The subscriber owns its failure; the stream keeps going.
    }
  }
}

interface RunningSession {
  proc: AgentProcess;
  /** Merges a burst of output per subscriber; the scrollback below stays synchronous. */
  out: OutputCoalescer<MethodContext>;
  scrollback: string;
  subscribers: Set<MethodContext>;
  session: SessionRow;
  /** stop() was asked for, so the exit that follows is no failure. */
  stopping: boolean;
  /** The pty's size, as last set: a remote viewer draws this grid rather than resizing it. */
  cols: number;
  rows: number;
}

/** What the runtime tells the status tracker; see src/daemon/session-status.ts. */
export interface RuntimeObserver {
  started(sessionId: string, cols?: number, rows?: number): void;
  resized?(sessionId: string, cols: number, rows: number): void;
  output(sessionId: string, chunk: string): void;
  input(sessionId: string, data?: string): void;
  exited(sessionId: string, code: number, requested: boolean): void;
}

/**
 * An observer that only watches the output stream (the error-line detector): a
 * NARROW type, so it composes with the full ones without loosening them — a typo in
 * a method name is a type error, not a silent skip.
 */
export interface OutputObserver {
  output(sessionId: string, chunk: string): void;
}

/**
 * Fans every `RuntimeObserver` call out to several observers — `SessionRuntime` takes
 * only one, but activity tracking and the setup-sentinel watcher are independent
 * concerns that both need to see the same output stream. Mirrors `notifyAll` above: one
 * observer throwing must not stop the others from seeing the event.
 */
export function combineObservers(
  ...observers: Array<RuntimeObserver | OutputObserver>
): RuntimeObserver {
  const forEach = (fn: (o: RuntimeObserver | OutputObserver) => void): void => {
    for (const o of observers) {
      try {
        fn(o);
      } catch {
        // Same contract as notifyAll: one observer's failure does not starve the rest.
      }
    }
  };
  return {
    // The `in` guards narrow the union: only a full observer gets the full calls.
    started: (id, cols, rows) => forEach((o) => { if ('started' in o) o.started(id, cols, rows); }),
    resized: (id, cols, rows) => forEach((o) => { if ('resized' in o) o.resized?.(id, cols, rows); }),
    output: (id, chunk) => forEach((o) => { if ('output' in o) o.output(id, chunk); }),
    input: (id, data) => forEach((o) => { if ('input' in o) o.input(id, data); }),
    exited: (id, code, requested) => forEach((o) => { if ('exited' in o) o.exited(id, code, requested); }),
  };
}

/**
 * What a re-attaching client needs from a session's screen. A TUI gets a serialized
 * repaint (its output is diffed cells, so a truncated byte tail cannot rebuild it);
 * a plain shell keeps the byte tail, which is its actual scrollback.
 */
export interface ScreenReplay {
  isTui(sessionId: string): boolean;
  snapshot(sessionId: string): Promise<string | undefined>;
}

export class SessionRuntime {
  private readonly running = new Map<string, RunningSession>();

  constructor(
    private readonly onExit: (sessionId: string, code: number) => void,
    private readonly observer?: RuntimeObserver,
    private readonly replay?: ScreenReplay,
  ) {}

  /** The shell pid of every running session, for the process-tree agent sweep. */
  pids(): Map<string, number> {
    return new Map([...this.running].map(([id, e]) => [id, e.proc.pid]));
  }

  private dataPayload(session: SessionRow, chunk: string): Record<string, unknown> {
    return { sessionId: session.id, workspaceId: session.workspaceId, chunk };
  }

  start(
    session: SessionRow,
    adapter: AgentAdapter,
    env: Record<string, string> = {},
  ): number {
    if (this.running.has(session.id)) {
      throw new CrossweaveError('SESSION_ALREADY_RUNNING', `Session already running: ${session.name}`);
    }
    if (session.worktreePath === null) {
      throw new CrossweaveError('SESSION_NO_WORKDIR', `Session has no working directory: ${session.name}`);
    }

    const proc = adapter.spawn({
      cwd: session.worktreePath,
      // CW_SESSION_ID/CW_SESSION_NAME are set last deliberately: a lease must never
      // be able to overwrite the session's own identity.
      env: { ...env, CW_SESSION_ID: session.id, CW_SESSION_NAME: session.name },
      cols: 80,
      rows: 24,
    });

    const entry: RunningSession = {
      proc, scrollback: '', subscribers: new Set(), session, stopping: false, cols: 80, rows: 24,
      out: new OutputCoalescer<MethodContext>({
        send: (sub, chunk) => sub.notify('session.data', this.dataPayload(session, chunk)),
      }),
    };

    this.running.set(session.id, entry);
    this.observer?.started(session.id, entry.cols, entry.rows);

    proc.onData((chunk) => {
      this.observer?.output(session.id, chunk);
      entry.scrollback = (entry.scrollback + chunk).slice(-SCROLLBACK_LIMIT);
      for (const sub of entry.subscribers) entry.out.push(sub, chunk);
    });

    proc.onExit((code) => {
      // Bookkeeping BEFORE notifying, deliberately. A throwing subscriber used to
      // abort this callback, so `running` never lost its entry and `onExit` never
      // ran: the session stayed wedged at `running` with a stale pid and could never
      // be started again. Task 7 isolated the ADAPTER's fan-out; this loop is a
      // second one and needed the same treatment.
      this.running.delete(session.id);
      this.observer?.exited(session.id, code, entry.stopping);
      this.onExit(session.id, code);
      // Pending output first: the exit line must not overtake the last bytes.
      entry.out.flushAll();
      notifyAll(entry.subscribers, 'session.exit', { sessionId: session.id, code });
    });

    return proc.pid;
  }

  private require(sessionId: string, name: string): RunningSession {
    const entry = this.running.get(sessionId);
    if (!entry) {
      throw new CrossweaveError('SESSION_NOT_RUNNING', `Session is not running: ${name}`);
    }
    return entry;
  }

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  write(sessionId: string, name: string, data: string): void {
    this.require(sessionId, name).proc.write(data);
    this.observer?.input(sessionId, data);
  }

  resize(sessionId: string, name: string, cols: number, rows: number): void {
    const entry = this.require(sessionId, name);
    entry.proc.resize(cols, rows);
    entry.cols = cols;
    entry.rows = rows;
    this.observer?.resized?.(sessionId, cols, rows);
  }

  size(sessionId: string): { cols: number; rows: number } | undefined {
    const entry = this.running.get(sessionId);
    return entry === undefined ? undefined : { cols: entry.cols, rows: entry.rows };
  }

  /**
   * Replays what this session shows to a client that just attached. A TUI gets the
   * serialized screen (see `ScreenReplay`); a shell gets its byte scrollback, exactly
   * as before. Returns a promise only for the TUI path, so the shell replay keeps
   * happening during `session.attach` (clients register their handler first).
   */
  subscribe(sessionId: string, name: string, ctx: MethodContext): void | Promise<void> {
    const entry = this.require(sessionId, name);
    if (this.replay?.isTui(sessionId) === true) return this.subscribeTui(sessionId, entry, ctx);
    this.attach(entry, ctx);
    this.replayScrollback(entry, ctx);
  }

  private attach(entry: RunningSession, ctx: MethodContext): void {
    // Attaching again (a client re-opening a session) replays the screen but must not
    // stack another close handler on the same connection each time.
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
  }

  private replayScrollback(entry: RunningSession, ctx: MethodContext): void {
    if (entry.scrollback.length === 0) return;
    const payload = this.dataPayload(entry.session, entry.scrollback);
    if (payload !== undefined) ctx.notify('session.data', payload);
  }

  private async subscribeTui(sessionId: string, entry: RunningSession, ctx: MethodContext): Promise<void> {
    let snapshot: string | undefined;
    try {
      snapshot = await this.replay?.snapshot(sessionId);
    } catch {
      // A screen that cannot serialize is no reason to leave the client blank; the
      // byte tail below is the old behaviour and still shows something.
      snapshot = undefined;
    }
    // The subscriber joins after the snapshot, so output that arrived meanwhile is not
    // delivered twice. The screen parsed it before serializing, so it is in the snapshot.
    this.attach(entry, ctx);
    if (snapshot !== undefined && snapshot !== '') {
      const payload = this.dataPayload(entry.session, `\x1bc${snapshot}`);
      if (payload !== undefined) ctx.notify('session.data', payload);
      return;
    }
    this.replayScrollback(entry, ctx);
  }

  /**
   * Hang up the session's shell and wait until it is actually gone, escalating if it
   * ignores the hangup. SIGHUP, not SIGTERM: an interactive shell ignores SIGTERM, so
   * every stop sat out the whole grace period; a hangup is what closing a terminal
   * sends, and the shell passes it on to whatever the user ran in it.
   *
   * Returning before the process has died is what let `resume` immediately after
   * `stop` see a still-live pty, short-circuit on `isRunning`, and report success
   * carrying a pid that was already dead — with the whole suite passing even when
   * `resume`'s restart path was gutted. It is the same gap that let `kill` clear the
   * pid while the process survived, stranding an agent with no record of it.
   */
  async stop(sessionId: string, graceMs = STOP_GRACE_MS): Promise<void> {
    const entry = this.running.get(sessionId);
    if (!entry) return;

    // A listener registered after the process already exited still fires, so this
    // cannot miss the event (proven by Task 7's late-onExit test).
    const exited = new Promise<void>((resolve) => {
      entry.proc.onExit(() => resolve());
    });

    entry.stopping = true;
    entry.proc.kill('SIGHUP');
    const escalate = setTimeout(() => entry.proc.kill('SIGKILL'), graceMs);
    try {
      await exited;
    } finally {
      clearTimeout(escalate);
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
  }
}
