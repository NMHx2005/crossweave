import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EnforcementTier } from '../db/repositories/session.js';
import type { AgentAdapter, AgentProcess, SpawnOptions } from './types.js';

/**
 * The `cw` binary's own path — `spawn` runs inside the daemon process, whose
 * PATH is whatever the client forwarded (see `clientEnv` in methods.ts),
 * which may not include wherever `cw` itself was installed, so this cannot
 * just be the bare command name in every case.
 *
 * Three tiers, most to least specific:
 * 1. In a COMPILED build, `process.execPath` is this very `cwd` binary's own
 *    path (a Bun-compiled standalone executable reports itself, not the Bun
 *    runtime) — `scripts/build.ts` always places `cw` and `cwd` side by
 *    side, so a sibling `cw` next to it is the release layout.
 * 2. In DEV (`bun run`), `process.execPath` is wherever `bun` itself lives,
 *    which tier 1 would resolve wrongly — `import.meta.url` instead points
 *    at this module's own real source location, and `cw`'s entry point is
 *    the sibling `src/cli/index.ts`.
 * 3. Neither guess matches (e.g. a global install with the two binaries in
 *    different directories) — fall back to the bare command name and let
 *    PATH resolve it, same as any other sibling-CLI convention.
 */
function cwBinaryPath(): string {
  const siblingOfExecutable = join(dirname(process.execPath), 'cw');
  if (existsSync(siblingOfExecutable)) return siblingOfExecutable;

  const siblingSource = fileURLToPath(new URL('../cli/index.ts', import.meta.url));
  if (existsSync(siblingSource)) return siblingSource;

  return 'cw';
}

function radarHookSettings(): string {
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: 'Edit|Write',
          hooks: [{ type: 'command', command: `${cwBinaryPath()} radar-hook`, timeout: 5 }],
        },
      ],
    },
  });
}

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
 * Tier T3: an opaque CLI driven over a pty. crossweave observes output but
 * cannot intercept tool calls, so Safe Mode here is advisory only (spec §2.1).
 */
export class ClaudePtyAdapter implements AgentAdapter {
  readonly kind = 'claude';
  readonly enforcementTier: EnforcementTier = 'T3';

  constructor(
    private readonly command = 'claude',
    private readonly args: string[] = [],
  ) {}

  spawn(opts: SpawnOptions): AgentProcess {
    let wrapper: PtyProcess | undefined;

    const proc = Bun.spawn([this.command, ...this.args, '--settings', radarHookSettings()], {
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
}
