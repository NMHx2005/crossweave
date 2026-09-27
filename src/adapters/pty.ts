import type { AgentProcess, SpawnOptions } from './types.js';
import { shellEnv } from '../core/shell-env.js';

type BunTerminal = { write(data: string): void; resize(cols: number, rows: number): void; close(): void };
type BunPtyProcess = { pid: number; exited: Promise<number>; terminal: BunTerminal; kill(signal?: number | NodeJS.Signals): void };

/**
 * Deliver to every listener even when one of them throws.
 *
 * A bare `for (const cb of listeners) cb(v)` aborts on the first throw, so every
 * listener registered after the bad one stops receiving anything — and because the
 * same subscriber throws on every subsequent emit, it never recovers. Task 13 fans
 * this out to several attached clients at once, where one broken viewer must not be
 * able to starve the rest.
 *
 * The error is swallowed rather than logged because M0 has nowhere to log it. M2
 * adds the event ledger; subscriber failures belong there.
 */
function fanOut<T>(listeners: ReadonlyArray<(value: T) => void>, value: T): void {
  for (const cb of listeners) {
    try {
      cb(value);
    } catch {
      // The subscriber owns its own failure; the stream keeps going.
    }
  }
}

class PtyProcess implements AgentProcess {
  private readonly dataListeners: Array<(chunk: string) => void> = [];
  private readonly exitListeners: Array<(code: number) => void> = [];
  private exitCode: number | null = null;

  constructor(private readonly proc: BunPtyProcess) {
    void proc.exited.then((code) => {
      this.exitCode = code;
      fanOut(this.exitListeners, code);
    });
  }

  /** Called by the adapter from Bun's single spawn-time data callback. */
  emit(chunk: string): void {
    fanOut(this.dataListeners, chunk);
  }

  get pid(): number {
    return this.proc.pid;
  }

  onData(cb: (chunk: string) => void): void {
    this.dataListeners.push(cb);
  }

  onExit(cb: (code: number) => void): void {
    // A listener registered after the process already exited must still fire.
    if (this.exitCode !== null) cb(this.exitCode);
    else this.exitListeners.push(cb);
  }

  write(data: string): void {
    this.proc.terminal.write(data);
  }

  resize(cols: number, rows: number): void {
    this.proc.terminal.resize(cols, rows);
  }

  kill(signal?: NodeJS.Signals): void {
    this.proc.kill(signal);
  }
}

/**
 * A decoder for one output stream. The pty hands over bytes cut anywhere, including
 * inside a character; a fresh decoder per chunk turned both halves into U+FFFD — the
 * `───` rules Claude Code draws ended in "���", Vietnamese lost letters, and each such
 * line wrapped a cell off. `stream: true` holds an incomplete tail for the next chunk.
 */
export function utf8Stream(): (chunk: string | Uint8Array) => string {
  const decoder = new TextDecoder('utf-8');
  return (chunk) => (typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
}

/**
 * Spawn `argv` in a fresh pty and wrap it as an AgentProcess: a session's shell and
 * every extra Terminal pane.
 */
export function spawnInPty(
  argv: string[],
  opts: Pick<SpawnOptions, 'cwd' | 'env' | 'cols' | 'rows'>,
): AgentProcess {
  let wrapper: PtyProcess | undefined;
  const decode = utf8Stream();
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: shellEnv(process.env, opts.env),
    terminal: {
      cols: opts.cols,
      rows: opts.rows,
      data(_terminal: unknown, chunk: string | Uint8Array) {
        const text = decode(chunk);
        wrapper?.emit(text);
      },
    },
  }) as unknown as BunPtyProcess;

  wrapper = new PtyProcess(proc);
  return wrapper;
}
