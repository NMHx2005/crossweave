import type { AgentProcess, SpawnOptions } from './types.js';

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
 * Spawn `argv` in a fresh pty and wrap it as an AgentProcess: a session's shell and
 * every extra Terminal pane.
 */
export function spawnInPty(
  argv: string[],
  opts: Pick<SpawnOptions, 'cwd' | 'env' | 'cols' | 'rows'>,
): AgentProcess {
  let wrapper: PtyProcess | undefined;
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env, TERM: 'xterm-256color' },
    terminal: {
      cols: opts.cols,
      rows: opts.rows,
      data(_terminal: unknown, chunk: string | Uint8Array) {
        const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
        wrapper?.emit(text);
      },
    },
  }) as unknown as BunPtyProcess;

  wrapper = new PtyProcess(proc);
  return wrapper;
}
