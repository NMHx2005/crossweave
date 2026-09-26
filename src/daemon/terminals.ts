import { CrossweaveError } from '../core/errors.js';
import { newId } from '../core/ids.js';
import type { AgentProcess } from '../adapters/types.js';
import type { SessionRow } from '../db/repositories/session.js';
import type { ChunkSealer } from '../gateway/e2e-sealer.js';
import type { MethodContext } from './server.js';

/** Same budget as a session's replay: enough to redraw a screen or two. */
const SCROLLBACK_LIMIT = 64 * 1024;

/** How long a shell gets to honour SIGHUP before SIGKILL. */
const CLOSE_GRACE_MS = 2000;

export interface TerminalInfo {
  terminalId: string;
  sessionId: string;
  sessionName: string;
  workspaceId: string;
}

interface OpenTerminal extends TerminalInfo {
  proc: AgentProcess;
  scrollback: string;
  subscribers: Set<MethodContext>;
  exited: Promise<void>;
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
 * (`closeForSession`), or with the daemon (`closeAll`). Output is sealed like
 * session.data, with the terminal id as the AAD.
 */
export class TerminalRegistry {
  private readonly open_ = new Map<string, OpenTerminal>();

  constructor(
    private readonly spawnShell: (session: SessionRow, terminalId: string) => AgentProcess,
    private readonly seal?: ChunkSealer,
    /** Called whenever the set of terminals changes, so clients can redraw. */
    private readonly onChange?: () => void,
  ) {}

  open(session: SessionRow): TerminalInfo {
    const terminalId = newId('t');
    const proc = this.spawnShell(session, terminalId);
    let resolveExited!: () => void;
    const entry: OpenTerminal = {
      terminalId, sessionId: session.id, sessionName: session.name, workspaceId: session.workspaceId,
      proc, scrollback: '', subscribers: new Set(),
      exited: new Promise<void>((r) => { resolveExited = r; }),
    };
    this.open_.set(terminalId, entry);

    proc.onData((chunk) => {
      entry.scrollback = (entry.scrollback + chunk).slice(-SCROLLBACK_LIMIT);
      const payload = this.payload(entry, chunk);
      if (payload !== undefined) notifyAll(entry.subscribers, 'terminal.data', payload);
    });
    proc.onExit((code) => {
      // Bookkeeping before notifying: a throwing subscriber must not leave a dead
      // shell listed (the same ordering SessionRuntime learned the hard way).
      this.open_.delete(terminalId);
      resolveExited();
      notifyAll(entry.subscribers, 'terminal.exit', { terminalId, code });
      this.onChange?.();
    });

    this.onChange?.();
    return this.info(entry);
  }

  list(workspaceId: string): TerminalInfo[] {
    return [...this.open_.values()].filter((t) => t.workspaceId === workspaceId).map((t) => this.info(t));
  }

  subscribe(terminalId: string, ctx: MethodContext): TerminalInfo {
    const entry = this.require(terminalId);
    entry.subscribers.add(ctx);
    ctx.onClose(() => entry.subscribers.delete(ctx));
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

  async closeForSession(sessionId: string): Promise<void> {
    const ids = [...this.open_.values()].filter((t) => t.sessionId === sessionId).map((t) => t.terminalId);
    await Promise.all(ids.map((id) => this.close(id)));
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.open_.keys()].map((id) => this.close(id)));
  }

  private require(terminalId: string): OpenTerminal {
    const entry = this.open_.get(terminalId);
    if (entry === undefined) throw new CrossweaveError('TERMINAL_NOT_FOUND', `No such terminal: ${terminalId}`);
    return entry;
  }

  private info(t: OpenTerminal): TerminalInfo {
    return { terminalId: t.terminalId, sessionId: t.sessionId, sessionName: t.sessionName, workspaceId: t.workspaceId };
  }

  private payload(t: OpenTerminal, chunk: string): Record<string, unknown> | undefined {
    const sealed = this.seal ? this.seal(chunk, { id: t.terminalId, workspaceId: t.workspaceId }) : chunk;
    if (sealed === undefined) return undefined;
    return { terminalId: t.terminalId, sessionId: t.sessionId, workspaceId: t.workspaceId, chunk: sealed };
  }
}
