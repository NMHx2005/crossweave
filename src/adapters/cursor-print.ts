import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentAdapter, AgentProcess, SpawnOptions } from './types.js';
import type { EnforcementTier } from '../db/repositories/session.js';

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
 * what `PrintProcess.write()` relies on below.
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
 * deltas are rendered; the untimestamped recap is dropped.
 */
interface StreamJsonLine {
  type?: unknown;
  timestamp_ms?: unknown;
  message?: { content?: Array<{ type?: unknown; text?: unknown }> };
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

  constructor(command: string, args: string[], opts: SpawnOptions) {
    this.child = spawn(command, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env } });
    this.pid = this.child.pid ?? -1;

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

  write(data: string): void {
    this.child.stdin?.write(data);
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
