import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, claudeProjectDir, codexRollouts, parseLines, readHead } from './agent-logs.js';

/**
 * How many tokens the agents run in a worktree have used, read from their own logs
 * (the same logs `latestWords` reads). Tokens only: the logs carry no price, and
 * prices change, so cost is the cockpit's arithmetic over prices the user sets.
 *
 * Best effort, like every reader of another program's private files: an unreadable or
 * reformatted log counts as nothing, never as an error.
 */

export interface TokenUsage {
  /** Fresh (uncached) input. */
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export interface SessionUsage {
  total: TokenUsage;
  byModel: Record<string, TokenUsage>;
}

const ZERO: TokenUsage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
/** Past this, a log is read from its end only: usage beyond it is not counted. */
const MAX_READ = 64 * 1024 * 1024;

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return { input: a.input + b.input, output: a.output + b.output, cacheWrite: a.cacheWrite + b.cacheWrite, cacheRead: a.cacheRead + b.cacheRead };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const time = (v: unknown): number => (typeof v === 'string' ? Date.parse(v) : Number.NaN);

type ClaudeRecord = { type: 'assistant'; timestamp: string; message: { id: string; model: string; usage: Record<string, unknown> } };

/** The part of a Claude Code log line usage needs, or undefined. */
function claudeRecord(entry: unknown): ClaudeRecord | undefined {
  const e = entry as { type?: unknown; timestamp?: unknown; message?: { id?: unknown; model?: unknown; usage?: unknown } } | null;
  if (e?.type !== 'assistant' || typeof e.timestamp !== 'string') return undefined;
  const m = e.message;
  if (typeof m?.id !== 'string' || typeof m.usage !== 'object' || m.usage === null) return undefined;
  return { type: 'assistant', timestamp: e.timestamp, message: { id: m.id, model: typeof m.model === 'string' ? m.model : 'unknown', usage: m.usage as Record<string, unknown> } };
}

/**
 * Claude Code: one message is written over several lines as it streams, each carrying
 * the message's usage — so each message id counts once (its last line).
 */
export function claudeUsageFrom(entries: unknown[], since: number): Record<string, TokenUsage> {
  const byId = new Map<string, ClaudeRecord>();
  for (const entry of entries) {
    const r = claudeRecord(entry);
    if (r && !(time(r.timestamp) < since)) byId.set(r.message.id, r);
  }
  const out: Record<string, TokenUsage> = {};
  for (const r of byId.values()) {
    const u = r.message.usage;
    out[r.message.model] = addUsage(out[r.message.model] ?? ZERO, {
      input: num(u.input_tokens),
      output: num(u.output_tokens),
      cacheWrite: num(u.cache_creation_input_tokens),
      cacheRead: num(u.cache_read_input_tokens),
    });
  }
  return out;
}

type CodexTotal = { at: number; input: number; cached: number; cacheWrite: number; output: number };

function codexTotal(entry: unknown): CodexTotal | undefined {
  const e = entry as { type?: unknown; timestamp?: unknown; payload?: { type?: unknown; info?: { total_token_usage?: Record<string, unknown> } } } | null;
  if (e?.type !== 'event_msg' || e.payload?.type !== 'token_count') return undefined;
  const t = e.payload.info?.total_token_usage;
  if (!t) return undefined;
  return { at: time(e.timestamp), input: num(t.input_tokens), cached: num(t.cached_input_tokens), cacheWrite: num(t.cache_write_input_tokens), output: num(t.output_tokens) };
}

function codexModel(entry: unknown): string | undefined {
  const e = entry as { type?: unknown; payload?: { model?: unknown } } | null;
  return e?.type === 'turn_context' && typeof e.payload?.model === 'string' ? e.payload.model : undefined;
}

/**
 * Codex writes running totals: a session's share is the last total minus the last one
 * written before it began. Its `input_tokens` includes the cached part.
 */
export function codexUsageFrom(entries: unknown[], since: number): Record<string, TokenUsage> {
  let model = 'codex';
  let before: CodexTotal | undefined;
  let last: CodexTotal | undefined;
  for (const entry of entries) {
    model = codexModel(entry) ?? model;
    const t = codexTotal(entry);
    if (!t) continue;
    if (t.at < since) before = t;
    else last = t;
  }
  if (!last) return {};
  const base = before ?? { at: 0, input: 0, cached: 0, cacheWrite: 0, output: 0 };
  const cached = Math.max(0, last.cached - base.cached);
  const input = Math.max(0, last.input - base.input - cached);
  return { [model]: { input, output: Math.max(0, last.output - base.output), cacheWrite: Math.max(0, last.cacheWrite - base.cacheWrite), cacheRead: cached } };
}

/**
 * The part of a Codex line usage needs, in the same shape — a `turn_context` line
 * carries the whole instructions text, which must not be kept for a model name.
 */
function codexKeep(entry: unknown): unknown {
  const e = entry as { type?: unknown; timestamp?: unknown; payload?: { info?: { total_token_usage?: unknown } } } | null;
  const model = codexModel(entry);
  if (model !== undefined) return { type: 'turn_context', payload: { model } };
  if (codexTotal(entry) !== undefined) {
    return { type: 'event_msg', timestamp: e?.timestamp, payload: { type: 'token_count', info: { total_token_usage: e?.payload?.info?.total_token_usage } } };
  }
  return undefined;
}

/** What a log file has given so far, kept small: only the records usage needs. */
type FileState = { size: number; offset: number; records: unknown[] };

/**
 * Reads logs incrementally: each file is read from where the last read stopped, so a
 * growing conversation costs its new lines, not the whole file, on every list.
 */
export class UsageReader {
  private readonly files = new Map<string, FileState>();
  /** A rollout's cwd never changes: read its first line once. */
  private readonly rolloutCwd = new Map<string, string | null>();

  constructor(private readonly home: string) {}

  private records(path: string, keep: (entry: unknown) => unknown): unknown[] {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      this.files.delete(path);
      return [];
    }
    let state = this.files.get(path);
    // Rewritten or truncated: start over.
    if (state === undefined || size < state.size) {
      state = { size: 0, offset: Math.max(0, size - MAX_READ), records: [] };
      this.files.set(path, state);
    }
    if (size > state.offset) {
      const fd = openSync(path, 'r');
      try {
        const buf = Buffer.alloc(size - state.offset);
        const n = readSync(fd, buf, 0, buf.length, state.offset);
        const text = buf.subarray(0, n).toString('utf8');
        // Only whole lines: the last one may still be being written.
        const end = text.lastIndexOf('\n');
        if (end >= 0) {
          for (const entry of parseLines(text.slice(0, end))) {
            const kept = keep(entry);
            if (kept !== undefined) state.records.push(kept);
          }
          state.offset += Buffer.byteLength(text.slice(0, end + 1), 'utf8');
        }
      } finally {
        closeSync(fd);
      }
    }
    state.size = size;
    return state.records;
  }

  private rolloutsFor(cwd: string): string[] {
    const want = new Set([cwd, canonical(cwd)]);
    return codexRollouts(this.home).filter((file) => {
      let found = this.rolloutCwd.get(file);
      if (found === undefined) {
        try {
          const first = parseLines(readHead(file).split('\n')[0] ?? '')[0] as { type?: string; payload?: { cwd?: unknown } } | undefined;
          found = first?.type === 'session_meta' && typeof first.payload?.cwd === 'string' ? first.payload.cwd : null;
        } catch {
          found = null;
        }
        this.rolloutCwd.set(file, found);
      }
      return found !== null && want.has(found);
    });
  }

  /** Everything used in `cwd` since `since` (epoch ms), by model and in total. */
  read(cwd: string, since: number): SessionUsage {
    const byModel: Record<string, TokenUsage> = {};
    const add = (part: Record<string, TokenUsage>): void => {
      for (const [model, u] of Object.entries(part)) byModel[model] = addUsage(byModel[model] ?? ZERO, u);
    };
    try {
      const dir = claudeProjectDir(this.home, cwd);
      if (existsSync(dir)) {
        for (const name of readdirSync(dir)) {
          if (!name.endsWith('.jsonl')) continue;
          add(claudeUsageFrom(this.records(join(dir, name), claudeRecord), since));
        }
      }
    } catch {
      // best effort
    }
    try {
      for (const file of this.rolloutsFor(cwd)) {
        add(codexUsageFrom(this.records(file, codexKeep), since));
      }
    } catch {
      // best effort
    }
    const total = Object.values(byModel).reduce(addUsage, ZERO);
    return { total, byModel };
  }
}

/**
 * Usage per session, refreshed in the background at most every `minIntervalMs` and
 * served from memory (session.list runs on every redraw). `refresh` resolves true when
 * some session's figures changed, so the daemon can tell clients to redraw.
 */
export class UsageTracker {
  private readonly usage = new Map<string, SessionUsage>();
  private lastRun = -Infinity;
  private running = false;

  constructor(
    private readonly reader: Pick<UsageReader, 'read'>,
    private readonly now: () => number = Date.now,
    private readonly minIntervalMs = 5000,
  ) {}

  get(sessionId: string): SessionUsage | undefined {
    return this.usage.get(sessionId);
  }

  async refresh(targets: () => ReadonlyArray<{ id: string; cwd: string; since: number }>): Promise<boolean> {
    if (this.running || this.now() - this.lastRun < this.minIntervalMs) return false;
    this.running = true;
    this.lastRun = this.now();
    try {
      let changed = false;
      const list = targets();
      const live = new Set(list.map((t) => t.id));
      for (const id of [...this.usage.keys()]) {
        if (!live.has(id)) {
          this.usage.delete(id);
          changed = true;
        }
      }
      for (const t of list) {
        const next = this.reader.read(t.cwd, t.since);
        const prev = this.usage.get(t.id);
        if (next.total.input + next.total.output + next.total.cacheWrite + next.total.cacheRead === 0) {
          if (prev) {
            this.usage.delete(t.id);
            changed = true;
          }
          continue;
        }
        if (JSON.stringify(prev) !== JSON.stringify(next)) {
          this.usage.set(t.id, next);
          changed = true;
        }
      }
      return changed;
    } finally {
      this.running = false;
    }
  }
}
