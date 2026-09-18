import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentAdapter, AgentProcess, SpawnOptions } from './types.js';
import { planSandbox } from '../isolation/sandbox.js';
import type { EnforcementTier } from '../db/repositories/session.js';
import { CrossweaveError } from '../core/errors.js';

/**
 * Real invocation observed for Task 3 Step 1 (2026-08-19, cursor-agent
 * 2026.08.11-e8db854, via `cd /tmp && cursor-agent --trust --print
 * --output-format stream-json --stream-partial-output "say hi"`, run directly on
 * this machine — not guessed):
 *
 *   {"type":"system","subtype":"init","apiKeySource":"login","cwd":"...","session_id":"...","model":"Auto","permissionMode":"default"}
 *   {"type":"user","message":{"role":"user","content":[{"type":"text","text":"say hi"}]},"session_id":"..."}
 *   {"type":"thinking","subtype":"delta","text":"The user wants a greeting.","session_id":"...","timestamp_ms":1787111810747}
 *   {"type":"thinking","subtype":"completed","session_id":"...","timestamp_ms":1787111811743}
 *   {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hi"}]},"session_id":"...","timestamp_ms":1787111811743}
 *   ... one line per streamed word, each carrying "timestamp_ms" ...
 *   {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hi. What would you like to work on?"}]},"session_id":"..."}
 *   {"type":"result","subtype":"success","duration_ms":5698,"is_error":false,"result":"Hi. What would you like to work on?","session_id":"...","usage":{...}}
 *
 * A second run with a prompt that triggers a shell tool call additionally showed:
 *
 *   {"type":"tool_call","subtype":"started","call_id":"...","tool_call":{"shellToolCall":{"args":{"command":"ls",...},...}},"session_id":"..."}
 *   {"type":"tool_call","subtype":"completed","call_id":"...","tool_call":{"shellToolCall":{...,"result":{"success":{...}}}},"session_id":"..."}
 *
 * The command also reads its prompt from stdin (verified with
 * `echo "say hi" | cursor-agent --trust --print --output-format stream-json
 * --stream-partial-output`) when no positional prompt argument is given, which is
 * what `PrintProcess.write()` relies on below. That first spike piped through
 * `echo`, which closes stdin via EOF immediately — a follow-up fix-round spike
 * (2026-08-19, captured during the M9 Task 3 real-binary spike) tested the
 * shipped `write()` shape directly (a raw pipe, `child.stdin.write(...)`, left
 * open) and found it produces NO output at all, ever — `--print` blocks
 * reading stdin until EOF. `write()` closes stdin right after the prompt is
 * finalized for exactly this reason; see its own doc comment below for the
 * full spike transcript.
 *
 * This is NOT the brief's placeholder shape (a flat `{type:'text', text}` object,
 * or a `tool_call` scalar field) — the real format nests rendered text at
 * `message.content[].text` under `type: "assistant"`, and every OTHER top-level
 * `type` (system/user/thinking/tool_call/result/...) carries no single text field
 * worth extracting on its own. The parser below is adjusted to match what was
 * actually observed, not the placeholder.
 *
 * Notably, `--stream-partial-output` double-reports each turn: every streamed
 * word arrives as its own `assistant` line carrying `timestamp_ms` (a genuine
 * delta), and once the turn settles the SAME text is re-sent once more,
 * concatenated, WITHOUT `timestamp_ms` — observed identically for both the
 * mid-turn recap right before a tool call (which additionally carries a
 * `model_call_id`) and the final end-of-response recap (which carries neither
 * field). Rendering both would print every reply twice, so only the timestamped
 * deltas are rendered; the untimestamped recap is dropped. This timestamp_ms
 * filter only makes sense because `--stream-partial-output` is in DEFAULT_ARGS
 * below — if that flag is ever removed, `assistant` lines stop carrying
 * timestamp_ms at all and this filter would silently drop every reply.
 */
interface StreamJsonLine {
  type?: unknown;
  timestamp_ms?: unknown;
  message?: { content?: Array<{ type?: unknown; text?: unknown }> };
  result?: unknown;
  is_error?: unknown;
  subtype?: unknown;
}

function renderStreamJsonLine(line: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return `${line}\n`;
  }
  if (typeof parsed !== 'object' || parsed === null) return `${line}\n`;

  const obj = parsed as StreamJsonLine;
  if (typeof obj.type !== 'string') return `${line}\n`;

  if (obj.type === 'assistant') {
    // Settled recap of an already-streamed turn (no timestamp_ms) — skip it, see
    // the header comment above for why.
    if (obj.timestamp_ms === undefined) return '';
    const content = obj.message?.content ?? [];
    return content
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('');
  }

  if (obj.type === 'result') {
    // The `result` line carries the turn's final outcome. On success its `result`
    // string just repeats what the `assistant` lines already rendered, so the
    // generic bracket is enough — but on failure it's the ONLY place the actual
    // error message lives; collapsing it to `[cursor: result]` would silently
    // discard the one thing the user needs to see. `is_error` is the primary
    // signal (per the header comment's captured transcript); `subtype !== 'success'`
    // is a fallback in case a future build reports failure only that way.
    const isError = obj.is_error === true || (typeof obj.subtype === 'string' && obj.subtype !== 'success');
    if (isError && typeof obj.result === 'string') return `${obj.result}\n`;
    return '[cursor: result]\n';
  }

  return `[cursor: ${obj.type}]\n`;
}

/** Deliver to every listener even when one of them throws — same fan-out contract as ClaudePtyAdapter's/AcpProcess's. */
function fanOut<T>(listeners: ReadonlyArray<(value: T) => void>, value: T): void {
  for (const cb of listeners) {
    try { cb(value); } catch { /* subscriber owns its failure */ }
  }
}

class PrintProcess implements AgentProcess {
  readonly pid: number;
  private readonly dataListeners: Array<(chunk: string) => void> = [];
  private readonly exitListeners: Array<(code: number) => void> = [];
  private exitCode: number | null = null;
  private readonly child: ChildProcess;
  // `--print` reads its whole prompt from stdin and only starts responding once
  // it sees EOF (verified for real — see the EOF spike comment on `write()`
  // below). One `PrintProcess` is therefore single-prompt-per-process: `write()`
  // closes stdin right after sending the prompt, and a second call is refused
  // rather than silently writing to an already-closed pipe.
  private stdinEnded = false;
  // `cw session attach` puts the terminal in raw mode and ships every keystroke
  // as its own `write()` call (see attach.ts's `onInput`) — a naive write() that
  // forwarded each call straight to the child and closed stdin immediately would
  // send only the first keystroke as the whole prompt. This buffers fragments
  // until a line terminator arrives; see `write()`'s own doc comment below.
  private buffer = '';

  constructor(command: string, args: string[], opts: SpawnOptions) {
    // Assembled here, like AcpProcess's: `command`/`args` are this adapter's argv
    // (see SpawnOptions.sandbox).
    const plan = opts.sandbox === undefined ? undefined : planSandbox(opts.sandbox, command, args);
    this.child = spawn(plan?.argv[0] ?? command, plan?.argv.slice(1) ?? args, { cwd: opts.cwd, env: { ...process.env, ...opts.env } });
    this.pid = this.child.pid ?? -1;
    // Drop the session-specific profile once the child is definitively gone — see
    // AcpProcess's identical registration for why it is bound to the child.
    if (plan !== undefined) {
      const cleanup = (): void => plan.cleanup();
      this.child.once('exit', cleanup);
      this.child.once('error', cleanup);
    }

    this.child.on('exit', (code) => {
      if (this.exitCode !== null) return;
      this.exitCode = code ?? 0;
      fanOut(this.exitListeners, this.exitCode);
    });

    // Node's `spawn` emits 'error' asynchronously (e.g. ENOENT) — an unhandled
    // 'error' event would otherwise crash the whole host process.
    this.child.on('error', () => {
      if (this.exitCode !== null) return;
      this.exitCode = 1;
      fanOut(this.exitListeners, this.exitCode);
    });

    // Forwarded exactly like AcpProcess does: stdout carries the stream-json
    // protocol, stderr does not, and an unread stderr from an unauthenticated
    // cursor-agent would otherwise give the user no signal and could wedge the
    // pipe once its buffer fills.
    this.child.stderr?.on('data', (chunk: Buffer) => {
      fanOut(this.dataListeners, chunk.toString('utf8'));
    });

    if (this.child.stdout) {
      const rl = createInterface({ input: this.child.stdout });
      rl.on('line', (line) => {
        const rendered = renderStreamJsonLine(line);
        if (rendered !== '') fanOut(this.dataListeners, rendered);
      });
    }
  }

  onData(cb: (chunk: string) => void): void {
    this.dataListeners.push(cb);
  }

  onExit(cb: (code: number) => void): void {
    if (this.exitCode !== null) cb(this.exitCode);
    else this.exitListeners.push(cb);
  }

  /**
   * EOF spike (2026-08-19, real `cursor-agent` binary, run with this dev
   * environment's own command-execution sandbox disabled — NOT a `cursor-agent
   * --sandbox` flag, that flag was never touched): spawned `cursor-agent`
   * with these exact args, wrote `"say hi\n"` via `child.stdin.write(...)`, and
   * left stdin open. Result: NO output at all — not even the `system`/`init`
   * line that normally appears within ~200ms — for 8+ seconds; the process was
   * clearly blocked reading stdin. The identical write immediately followed by
   * `child.stdin.end()` produced the full stream-json transcript (init → user →
   * thinking → assistant deltas → result) starting within ~200ms. Conclusion:
   * `--print` mode requires stdin EOF before it begins processing the prompt —
   * an open-forever stdin (the brief's original design, modeled on `AcpProcess`)
   * would never produce a response. `write()` therefore ends stdin right after
   * the prompt is finalized, making a `PrintProcess` single-prompt-per-process;
   * a second finalized `write()` call throws instead of silently writing to a
   * dead pipe.
   *
   * Buffering (M9 fix-wave): `cw session attach` (attach.ts) puts stdin in raw
   * mode and calls `write()` once per keystroke — sending each call straight to
   * the child and closing stdin immediately would turn the FIRST keystroke into
   * the entire prompt and kill every keystroke after it. So `write()` only
   * accumulates into `this.buffer` until it sees a line terminator: raw-mode
   * TTYs send `\r` for Enter, not `\n`, while piped/non-interactive input may
   * send `\n` — both finalize. Until then the child process is never touched.
   */
  write(data: string): void {
    if (this.stdinEnded) {
      throw new CrossweaveError(
        'AGENT_INPUT_CLOSED',
        'PrintProcess.write() called after stdin was already closed — cursor-print (T3) ' +
        'sessions are single-prompt-per-process; spawn a new process for the next prompt.',
      );
    }
    this.buffer += data;
    if (!/[\r\n]/.test(data)) return;
    this.stdinEnded = true;
    this.child.stdin?.write(this.buffer);
    this.child.stdin?.end();
  }

  resize(_cols: number, _rows: number): void {
    // No-op — stream-json print mode has no terminal concept.
  }

  kill(signal?: NodeJS.Signals): void {
    this.child.kill(signal);
  }
}

/**
 * Tier T3: no permission interception. `--print --output-format stream-json`
 * exposes no hook equivalent to ACP's `session/request_permission` (T1) or the
 * Claude Code PreToolUse hook (T2) — Collision Radar still warns via bus
 * messages, but writes are never blocked (see
 * docs/superpowers/specs/2026-08-12-m5a-safe-mode-blocking-design.md). This
 * adapter exists because current cursor-agent builds dropped ACP support
 * (see AcpAdapter's own comment, and ACP_HANDSHAKE_TIMEOUT_MS) — `--print
 * --output-format stream-json` is the still-supported fallback.
 */
export class CursorPrintAdapter implements AgentAdapter {
  readonly kind = 'cursor-print';
  readonly enforcementTier: EnforcementTier = 'T3';

  static readonly DEFAULT_ARGS: string[] = [
    '--trust', '--print', '--output-format', 'stream-json', '--stream-partial-output',
  ];

  constructor(
    private readonly command = 'cursor-agent',
    private readonly args: string[] = CursorPrintAdapter.DEFAULT_ARGS,
  ) {}

  spawn(opts: SpawnOptions): AgentProcess {
    return new PrintProcess(this.command, this.args, opts);
  }
}
