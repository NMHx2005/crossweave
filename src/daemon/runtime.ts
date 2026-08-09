import { CrossweaveError } from '../core/errors.js';
import type { AgentAdapter, AgentProcess } from '../adapters/types.js';
import type { SessionRow } from '../db/repositories/session.js';
import type { MethodContext } from './server.js';

const SCROLLBACK_LIMIT = 64 * 1024;

/** How long an agent gets to honour SIGTERM before SIGKILL. */
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
  scrollback: string;
  subscribers: Set<MethodContext>;
}

export class SessionRuntime {
  private readonly running = new Map<string, RunningSession>();

  constructor(private readonly onExit: (sessionId: string, code: number) => void) {}

  start(session: SessionRow, adapter: AgentAdapter): number {
    if (this.running.has(session.id)) {
      throw new CrossweaveError('SESSION_ALREADY_RUNNING', `Session already running: ${session.name}`);
    }
    if (session.worktreePath === null) {
      throw new CrossweaveError('SESSION_NO_WORKDIR', `Session has no working directory: ${session.name}`);
    }

    const proc = adapter.spawn({
      cwd: session.worktreePath,
      env: { CW_SESSION_ID: session.id, CW_SESSION_NAME: session.name },
      cols: 80,
      rows: 24,
    });

    const entry: RunningSession = { proc, scrollback: '', subscribers: new Set() };
    this.running.set(session.id, entry);

    proc.onData((chunk) => {
      entry.scrollback = (entry.scrollback + chunk).slice(-SCROLLBACK_LIMIT);
      notifyAll(entry.subscribers, 'session.data', { sessionId: session.id, chunk });
    });

    proc.onExit((code) => {
      // Bookkeeping BEFORE notifying, deliberately. A throwing subscriber used to
      // abort this callback, so `running` never lost its entry and `onExit` never
      // ran: the session stayed wedged at `running` with a stale pid and could never
      // be started again. Task 7 isolated the ADAPTER's fan-out; this loop is a
      // second one and needed the same treatment.
      this.running.delete(session.id);
      this.onExit(session.id, code);
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
  }

  resize(sessionId: string, name: string, cols: number, rows: number): void {
    this.require(sessionId, name).proc.resize(cols, rows);
  }

  subscribe(sessionId: string, name: string, ctx: MethodContext): void {
    const entry = this.require(sessionId, name);
    entry.subscribers.add(ctx);
    ctx.onClose(() => entry.subscribers.delete(ctx));
    if (entry.scrollback.length > 0) {
      ctx.notify('session.data', { sessionId, chunk: entry.scrollback });
    }
  }

  /**
   * Signal the agent and wait until it is actually gone, escalating if it ignores
   * SIGTERM.
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

    entry.proc.kill('SIGTERM');
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
