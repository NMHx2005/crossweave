import { CrossweaveError } from '../core/errors.js';
import type { AgentAdapter, AgentProcess } from '../adapters/types.js';
import type { SessionRow } from '../db/repositories/session.js';
import type { MethodContext } from './server.js';

const SCROLLBACK_LIMIT = 64 * 1024;

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
      for (const sub of entry.subscribers) {
        sub.notify('session.data', { sessionId: session.id, chunk });
      }
    });

    proc.onExit((code) => {
      for (const sub of entry.subscribers) {
        sub.notify('session.exit', { sessionId: session.id, code });
      }
      this.running.delete(session.id);
      this.onExit(session.id, code);
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

  stop(sessionId: string): void {
    const entry = this.running.get(sessionId);
    if (!entry) return;
    entry.proc.kill('SIGTERM');
  }

  stopAll(): void {
    for (const id of [...this.running.keys()]) this.stop(id);
  }
}
