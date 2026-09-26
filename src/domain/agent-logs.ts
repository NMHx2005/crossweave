import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * Reading an agent's OWN session logs, keyed by the session's worktree path — which is
 * unique per crossweave session, so "the newest conversation in this directory" is
 * that session's conversation. Two uses:
 *
 * - `findConversation`: the id to resume, so starting a session again continues its
 *   conversation instead of opening a blank one.
 * - `latestWords`: the agent's last assistant text, for the rail.
 *
 * Every reader is best effort: a missing, partial or reformatted log means "nothing
 * known", never an error — these are other programs' private files.
 */

export interface LogLocation {
  home: string;
  /** The session's worktree. */
  cwd: string;
}

export interface ConversationDeps extends LogLocation {
  /** `opencode session list --format json`'s output (injected: it spawns a process). */
  listOpencode: () => Promise<string>;
}

/** How many of the newest Codex rollouts to open when looking for this worktree's. */
const CODEX_SCAN_LIMIT = 200;
const TAIL_BYTES = 256 * 1024;
const WORDS_MAX = 160;

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Claude Code's per-project log dir: the real path with every non-alphanumeric → `-`. */
export function claudeProjectDir(home: string, cwd: string): string {
  return join(home, '.claude', 'projects', canonical(cwd).replace(/[^A-Za-z0-9]/g, '-'));
}

function newestFile(dir: string, filter: (name: string) => boolean): string | undefined {
  if (!existsSync(dir)) return undefined;
  let best: { path: string; mtime: number } | undefined;
  for (const name of readdirSync(dir)) {
    if (!filter(name)) continue;
    const path = join(dir, name);
    try {
      const mtime = statSync(path).mtimeMs;
      if (best === undefined || mtime > best.mtime) best = { path, mtime };
    } catch {
      // vanished while listing
    }
  }
  return best?.path;
}

function claudeLogFile(loc: LogLocation): string | undefined {
  return newestFile(claudeProjectDir(loc.home, loc.cwd), (n) => n.endsWith('.jsonl'));
}

function readHead(path: string, bytes = 64 * 1024): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function readTail(path: string, bytes = TAIL_BYTES): string {
  const size = statSync(path).size;
  const start = Math.max(0, size - bytes);
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    const n = readSync(fd, buf, 0, buf.length, start);
    const text = buf.subarray(0, n).toString('utf8');
    // A tail that starts mid-line would parse as garbage; drop the partial first line.
    return start === 0 ? text : text.slice(text.indexOf('\n') + 1);
  } finally {
    closeSync(fd);
  }
}

function parseLines(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a line still being written, or not JSON at all
    }
  }
  return out;
}

/** Newest-first rollout files under ~/.codex/sessions (their names sort by time). */
function codexRollouts(home: string): string[] {
  const root = join(home, '.codex', 'sessions');
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) files.push(path);
    }
  };
  walk(root);
  return files.sort((a, b) => basename(b).localeCompare(basename(a))).slice(0, CODEX_SCAN_LIMIT);
}

function codexLogFor(loc: LogLocation): { file: string; id: string } | undefined {
  const want = new Set([loc.cwd, canonical(loc.cwd)]);
  for (const file of codexRollouts(loc.home)) {
    try {
      const first = parseLines(readHead(file).split('\n')[0] ?? '')[0] as
        { type?: string; payload?: { id?: unknown; cwd?: unknown } } | undefined;
      if (first?.type !== 'session_meta') continue;
      const { id, cwd } = first.payload ?? {};
      if (typeof id === 'string' && typeof cwd === 'string' && want.has(cwd)) return { file, id };
    } catch {
      // unreadable rollout
    }
  }
  return undefined;
}

export async function findConversation(agentKind: string, deps: ConversationDeps): Promise<string | undefined> {
  try {
    if (agentKind === 'claude') {
      const file = claudeLogFile(deps);
      return file === undefined ? undefined : basename(file, '.jsonl');
    }
    if (agentKind === 'codex') return codexLogFor(deps)?.id;
    if (agentKind === 'opencode') {
      const list = JSON.parse(await deps.listOpencode()) as Array<{ id?: unknown; directory?: unknown; updated?: unknown }>;
      const want = new Set([deps.cwd, canonical(deps.cwd)]);
      const mine = list
        .filter((s) => typeof s.id === 'string' && typeof s.directory === 'string' && want.has(s.directory))
        .sort((a, b) => Number(b.updated ?? 0) - Number(a.updated ?? 0));
      return mine[0]?.id as string | undefined;
    }
  } catch {
    // best effort: no conversation found means a fresh start
  }
  return undefined;
}

function oneLine(text: string): string | undefined {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') return undefined;
  return flat.length > WORDS_MAX ? `${flat.slice(0, WORDS_MAX - 1)}…` : flat;
}

function lastText(entries: unknown[], pick: (entry: unknown) => string | undefined): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const text = pick(entries[i]);
    if (text !== undefined && text.trim() !== '') return text;
  }
  return undefined;
}

/** The agent's last assistant text, on one line, or undefined when unknown. */
export function latestWords(agentKind: string, loc: LogLocation): string | undefined {
  try {
    if (agentKind === 'claude') {
      const file = claudeLogFile(loc);
      if (file === undefined) return undefined;
      const text = lastText(parseLines(readTail(file)), (e) => {
        const entry = e as { type?: string; message?: { content?: unknown } };
        if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) return undefined;
        const texts = (entry.message.content as Array<{ type?: string; text?: string }>)
          .filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text as string);
        return texts.at(-1);
      });
      return text === undefined ? undefined : oneLine(text);
    }
    if (agentKind === 'codex') {
      const found = codexLogFor(loc);
      if (found === undefined) return undefined;
      const text = lastText(parseLines(readTail(found.file)), (e) => {
        const entry = e as { type?: string; payload?: { type?: string; role?: string; message?: string; content?: unknown } };
        if (entry.type === 'event_msg' && entry.payload?.type === 'agent_message') return entry.payload.message;
        if (entry.type === 'response_item' && entry.payload?.type === 'message' && entry.payload.role === 'assistant'
          && Array.isArray(entry.payload.content)) {
          return (entry.payload.content as Array<{ type?: string; text?: string }>)
            .filter((c) => c.type === 'output_text' && typeof c.text === 'string').map((c) => c.text as string).at(-1);
        }
        return undefined;
      });
      return text === undefined ? undefined : oneLine(text);
    }
  } catch {
    // best effort
  }
  return undefined;
}
