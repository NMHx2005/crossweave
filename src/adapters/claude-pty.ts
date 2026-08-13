import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EnforcementTier } from '../db/repositories/session.js';
import type { AgentAdapter, AgentProcess, SpawnOptions } from './types.js';

/**
 * The full shell command that invokes a `cw` subcommand — `spawn` runs inside
 * the daemon process, whose PATH is whatever the client forwarded (see
 * `clientEnv` in methods.ts), which may not include wherever `cw` itself was
 * installed, so this cannot just be the bare command name in every case.
 * Generalized from M3's `radarHookInvocation` (same three-tier resolution, now
 * parameterized by subcommand) so M6a's statusLine command can reuse it instead of
 * duplicating the resolution logic.
 *
 * Three tiers, most to least specific, mirroring `resolveDaemonEntry` in
 * `client/rpc-client.ts` (same compiled-vs-source problem, same fix):
 * 1. In a COMPILED build, `process.execPath` is this very `cwd` binary's own
 *    path (a Bun-compiled standalone executable reports itself, not the Bun
 *    runtime) — `scripts/build.ts` always places `cw` and `cwd` side by
 *    side, so a sibling `cw` next to it is the release layout, and that
 *    sibling IS directly executable.
 * 2. In DEV (`bun run`), `process.execPath` is wherever `bun` itself lives,
 *    which tier 1 would resolve wrongly — `import.meta.url` instead points
 *    at this module's own real source location, and `cw`'s entry point is
 *    the sibling `src/cli/index.ts`. That source file is checked into git
 *    WITHOUT an executable bit, so it cannot be run directly — the command
 *    must go through the interpreter that is currently running this very
 *    process (`process.execPath`, i.e. `bun`), with the source path passed
 *    as its argument, exactly like `resolveDaemonEntry` does for the
 *    daemon's own source-mode case.
 * 3. Neither guess matches (e.g. a global install with the two binaries in
 *    different directories) — fall back to the bare command name and let
 *    PATH resolve it, same as any other sibling-CLI convention.
 */
function cwInvocation(subcommand: string): string {
  const siblingOfExecutable = join(dirname(process.execPath), 'cw');
  if (existsSync(siblingOfExecutable)) return `${siblingOfExecutable} ${subcommand}`;

  const siblingSource = fileURLToPath(new URL('../cli/index.ts', import.meta.url));
  if (existsSync(siblingSource)) return `${process.execPath} ${siblingSource} ${subcommand}`;

  return `cw ${subcommand}`;
}

function radarHookSettings(): string {
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: '^(Edit|Write)$',
          hooks: [{ type: 'command', command: cwInvocation('radar-hook'), timeout: 5 }],
        },
      ],
    },
    // M6a: reuses the exact same --settings JSON crossweave already injects for the
    // PreToolUse hook (design doc §2) — no new spawn-time surface.
    statusLine: {
      type: 'command',
      command: cwInvocation('session-usage-hook'),
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
 * Tier T2: drives Claude Code over a pty, but with a real interception point —
 * every invocation gets a `PreToolUse` hook (`radarHookSettings` below) that can
 * allow OR deny a tool call. That is exactly what the roadmap defines T2 to mean
 * (`docs/superpowers/specs/2026-08-09-crossweave-design.md` §4.10: "Claude Code
 * natively (hooks + headless SDK + MCP), giving T2") — this adapter was mislabeled
 * T3 from M0, before M3 wired the hook up; M5a corrects the label to match the
 * capability. T1 (ACP's structured permission boundary) is stronger still: the
 * hook's `matcher: 'Edit|Write'` cannot see a file write made through the `Bash`
 * tool, a blind spot ACP's boundary does not have.
 */
export class ClaudePtyAdapter implements AgentAdapter {
  readonly kind = 'claude';
  readonly enforcementTier: EnforcementTier = 'T2';

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
