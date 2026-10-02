import { copyFileSync, chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { CrossweaveError } from './errors.js';
import { globalCrossweaveDir } from './paths.js';

/**
 * `cw hooks install|remove` — wire an agent's own hook system to `cw notify`, so a
 * session's row says "done"/"needs you" exactly (the screen is only a guess; see
 * src/daemon/session-status.ts). Crossweave never launches agents; it only writes
 * entries INTO the agent's own config, under the rules of
 * docs/superpowers/specs/2026-10-01-ai-debug-loop-design.md §1:
 *
 * - pre-flight: every target file is read (and parsed) BEFORE anything is written;
 *   a malformed file is never overwritten;
 * - atomic writes: a temp file in the same directory, renamed over the original;
 * - re-read immediately before write (TOCTOU): the merge is computed from the
 *   freshest read, not from the pre-flight one;
 * - backup: the first time a pre-existing file is touched, a copy goes to
 *   ~/.crossweave/hooks-backup/ (0600);
 * - provenance in ~/.crossweave/hooks-installed.json (0600) — what crossweave added,
 *   so `remove` takes back exactly its own entries;
 * - install twice is a no-op; nothing user-typed is interpolated into hook commands.
 */

/** The fixed notify invocations a hook runs — args only; the binary comes from `prefix`. */
export const DONE_NOTIFY_ARGS = 'notify --kind done "finished its turn"';
export const ASK_NOTIFY_ARGS = 'notify --kind ask "needs your answer"';

export const DONE_NOTIFY = `cw ${DONE_NOTIFY_ARGS}`;
export const ASK_NOTIFY = `cw ${ASK_NOTIFY_ARGS}`;

/** The agent command a hook runs: the running cw itself, so a custom install dir or a
 * source checkout both keep working even when a hook shell has no PATH entry.
 * `sh`-safe (words quoted for a `sh -c`) and TOML-safe (basic-string escaped). */
export function cwHookPrefix(argv1: string | undefined, cwd = process.cwd()): string {
  if (argv1 === undefined || argv1 === '') return 'cw';
  const abs = argv1.startsWith('/') ? argv1 : join(cwd, argv1);
  try {
    if (statSync(abs).isFile()) {
      // A .ts entry means bun ran it from source: the hook needs bun back, not a
      // reference to a file sh cannot execute. The extension, not the exact layout.
      if (abs.endsWith('.ts')) return `bun ${abs}`;
      return abs;
    }
  } catch {
    // Not a file (a REPL, a bundler alias): the PATH entry is the best guess.
  }
  return 'cw';
}

/** One shell word, safe inside `sh -c`: quoted unless it is already plain. */
function shWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * The prefix as a sh command line. A prefix is a single word — `cw`, or the cw
 * binary's own path WHATEVER it contains — or `<program> <path>` when bun ran it
 * from source; only that case splits, and only once, after the program.
 */
function shPrefix(prefix: string): string {
  if (prefix.startsWith('bun ')) return `${shWord('bun')} ${shWord(prefix.slice(4))}`
  return shWord(prefix)
}

/** A sh command line as a TOML basic string (backslash and quote escaped). */
function tomlString(s: string): string {
  return `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export interface HooksIo {
  readText(path: string): string | undefined;
  writeTextAtomic(path: string, content: string): void;
  backup(from: string, to: string): void;
  mkdirs(path: string): void;
  chmodPrivate(path: string): void;
}

export function nodeHooksIo(): HooksIo {
  return {
    readText(path) {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return undefined;
      }
    },
    writeTextAtomic(path, content) {
      // A dotfiles manager keeps these configs as SYMLINKS: a rename over the link
      // would replace it with a plain file. Write the link's TARGET (the link stays).
      let at = path;
      try {
        if (lstatSync(path).isSymbolicLink()) at = realpathSync(path);
      } catch {
        // No file yet (or an unreadable middle): write where asked.
      }
      mkdirSync(dirname(at), { recursive: true });
      const tmp = `${at}.cw-tmp-${process.pid}-${Date.now()}`;
      // 0600 at birth: the temp sits beside files that hold API keys.
      writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
      // rename replaces the inode: without this, a settings.json the user had at 0600
      // would come back 0644 world-readable.
      try {
        chmodSync(tmp, statSync(at).mode & 0o777);
      } catch {
        // A brand-new file: stay 0600 — the conservative default for these configs.
      }
      renameSync(tmp, at);
    },
    backup(from, to) {
      copyFileSync(from, to);
      chmodSync(to, 0o600);
    },
    mkdirs(path) {
      mkdirSync(path, { recursive: true });
      try {
        chmodSync(path, 0o700);
      } catch {
        // Our own directory; an odd umask is not worth failing over.
      }
    },
    chmodPrivate(path) {
      chmodSync(path, 0o600);
    },
  };
}

export const SUPPORTED_AGENTS = ['claude', 'codex'] as const;
export type HookAgent = (typeof SUPPORTED_AGENTS)[number];

/** Agents that exist but have no hook system to wire — refused with AGENT_NO_HOOKS.
 * (As of 2026-10: Gemini CLI offers no lifecycle hooks to call a command with; the
 * claim is version-specific and re-checked when a version with hooks appears.) */
const KNOWN_WITHOUT_HOOKS = new Set<string>(['gemini']);

/** What install/remove would do with this agent, so a CLI can refuse BEFORE asking. */
export function agentWiring(agent: string): 'supported' | 'no-hooks' | 'unknown' {
  if (SUPPORTED.has(agent)) return 'supported';
  if (KNOWN_WITHOUT_HOOKS.has(agent)) return 'no-hooks';
  return 'unknown';
}

export type HookInstallOutcome =
  | { status: 'ok'; agent: string; file: string; adds: string[] }
  | { status: 'noop'; agent: string; file: string }
  | { status: 'refused'; agent: string; code: string; message: string };

export type HookRemoveOutcome =
  | { status: 'ok'; agent: string; file: string }
  | { status: 'noop'; agent: string }
  | { status: 'refused'; agent: string; code: string; message: string };

export interface HooksOptions {
  home?: string;
  io?: HooksIo;
  /** The cw the hook invokes, as `cwHookPrefix` resolved it; tests use the plain name. */
  prefix?: string;
}

function refused(agent: string, code: string, message: string): HookInstallOutcome {
  return { status: 'refused', agent, code, message };
}

const SUPPORTED = new Set<string>(SUPPORTED_AGENTS);

/** Install for ONE agent: the caller loops for several and reports per agent. */
export function installHooks(agent: string, opts: HooksOptions = {}): HookInstallOutcome {
  if (KNOWN_WITHOUT_HOOKS.has(agent)) {
    return refused(agent, 'AGENT_NO_HOOKS', `${agent} has no hook system to wire; its config offers no reliable lifecycle event`);
  }
  if (!SUPPORTED.has(agent)) {
    return refused(agent, 'INVALID_ARGUMENTS', `Unknown agent '${agent}'. Supported: ${SUPPORTED_AGENTS.join(', ')} — ${[...KNOWN_WITHOUT_HOOKS].join(', ')} have none to wire.`);
  }
  return agent === 'claude' ? installClaude(opts) : installCodex(opts);
}

export function removeHooks(agent: string, opts: HooksOptions = {}): HookRemoveOutcome {
  if (KNOWN_WITHOUT_HOOKS.has(agent)) {
    return { status: 'refused', agent, code: 'AGENT_NO_HOOKS', message: `${agent} has no hook system to wire; nothing to remove` };
  }
  if (!SUPPORTED.has(agent)) {
    return { status: 'refused', agent, code: 'INVALID_ARGUMENTS', message: `Unknown agent '${agent}'. Supported: ${SUPPORTED_AGENTS.join(', ')}` };
  }
  return agent === 'claude' ? removeClaude(opts) : removeCodex(opts);
}

// --- claude -------------------------------------------------------------

interface ClaudeHookEntry { matcher?: string; hooks?: Array<{ type?: string; command?: string }> }

function claudeSettingsPath(home: string): string {
  return join(home, '.claude', 'settings.json');
}

function installClaude(opts: HooksOptions): HookInstallOutcome {
  const io = opts.io ?? nodeHooksIo();
  const home = opts.home ?? homedir();
  const file = claudeSettingsPath(home);
  const shLine = shPrefix(opts.prefix ?? cwHookPrefix(process.argv[1]));
  const doneEntry = { matcher: '', hooks: [{ type: 'command', command: `${shLine} ${DONE_NOTIFY_ARGS}` }] };
  const askEntry = { matcher: '', hooks: [{ type: 'command', command: `${shLine} ${ASK_NOTIFY_ARGS}` }] };

  const raw = io.readText(file);
  let parsed: Record<string, unknown>;
  if (raw === undefined) {
    parsed = {};
  } else {
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // An unparseable file is never overwritten: that would destroy the user's config.
      return refused('claude', 'AGENT_CONFIG_MALFORMED', `${file} is not valid JSON; fix it (or move it aside) first`);
    }
  }
  const hooks = (parsed['hooks'] ?? {}) as Record<string, unknown>;
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) {
    return refused('claude', 'HOOKS_SHAPE', `${file}: the "hooks" key is not an object`);
  }
  const wanted: Array<{ event: 'Stop' | 'Notification'; entry: ClaudeHookEntry; label: string; args: string }> = [
    { event: 'Stop', entry: doneEntry, label: 'Stop → cw notify done', args: DONE_NOTIFY_ARGS },
    { event: 'Notification', entry: askEntry, label: 'Notification → cw notify ask', args: ASK_NOTIFY_ARGS },
  ];
  for (const { event } of wanted) {
    const list = hooks[event];
    if (list !== undefined && !Array.isArray(list)) {
      return refused('claude', 'HOOKS_SHAPE', `${file}: hooks.${event} is not a list`);
    }
  }
  const changes = wanted.filter(({ event, args }) => {
    const list = hooks[event];
    if (list === undefined) return true;
    // Match by our fixed argument string, whatever binary name it was installed with.
    return !hasOurArgs(list as unknown[], args);
  });
  if (changes.length === 0) return { status: 'noop', agent: 'claude', file };

  // ONE fresh read, one write: Claude Code may have written the file since pre-flight,
  // or a parallel install may have added the same entry — re-check on the fresh text.
  const now = io.readText(file);
  let fresh: Record<string, unknown>;
  if (now === undefined) fresh = {};
  else {
    try {
      fresh = JSON.parse(now) as Record<string, unknown>;
    } catch {
      return refused('claude', 'AGENT_CONFIG_MALFORMED', `${file} changed and is no longer valid JSON; nothing was written`);
    }
  }
  const freshHooks = (fresh['hooks'] ?? {}) as Record<string, unknown>;
  if (typeof freshHooks !== 'object' || freshHooks === null || Array.isArray(freshHooks)) {
    return refused('claude', 'HOOKS_SHAPE', `${file}: the "hooks" key is not an object`);
  }
  for (const change of changes) {
    const list = freshHooks[change.event];
    if (!Array.isArray(list)) {
      if (list !== undefined) return refused('claude', 'HOOKS_SHAPE', `${file}: hooks.${change.event} is not a list`);
    } else if (hasOurArgs(list, change.args)) continue;
    freshHooks[change.event] = Array.isArray(list) ? [...list, change.entry] : [change.entry];
  }
  fresh['hooks'] = freshHooks;
  writeBack(
    io, file, raw, JSON.stringify(fresh, null, 2) + '\n', 'claude',
    changes.map((c) => c.label).join(', '), home,
  );
  return { status: 'ok', agent: 'claude', file, adds: changes.map((c) => c.label) };
}

/** Ours by our fixed argument string, whatever binary name it was installed with. */
function hasOurArgs(list: unknown[], args: string): boolean {
  return list.some((item) => {
    const hooks = (item as ClaudeHookEntry | null)?.hooks;
    return Array.isArray(hooks) && hooks.some((h) => h?.command !== undefined && h.command.includes(args));
  });
}

// --- codex --------------------------------------------------------------

function codexConfigPath(home: string): string {
  return join(home, '.codex', 'config.toml');
}

/** Codex's `notify` program fires on turn completion — a `done`, nothing else it offers. */
function installCodex(opts: HooksOptions): HookInstallOutcome {
  const io = opts.io ?? nodeHooksIo();
  const home = opts.home ?? homedir();
  const file = codexConfigPath(home);
  const shLine = shPrefix(opts.prefix ?? cwHookPrefix(process.argv[1]));
  const raw = io.readText(file);
  if (raw === undefined) {
    return refused('codex', 'AGENT_CONFIG_MISSING', `No ${file} — is Codex installed?`);
  }
  const line = `notify = ["sh", "-c", ${tomlString(`${shLine} ${DONE_NOTIFY_ARGS}`)}]`;
  const existing = notifyKeyLine(raw);
  if (existing !== undefined) {
    // Found ANYWHERE in the file — a multi-line array's key line still matches, and
    // inserting a second top-level `notify` would break Codex's parse of the whole
    // file. Ours is matched escape-proof (TOML may quote the message's quotes).
    return oursNotifyLine(existing)
      ? { status: 'noop', agent: 'codex', file }
      : refused('codex', 'HOOKS_KEY_TAKEN', `${file} already has a "notify" key that is not crossweave's; merge it by hand if you want both`);
  }
  const content = insertTopLevelKey(raw, line);
  writeBack(io, file, raw, content, 'codex', 'notify → cw notify done', home);
  return { status: 'ok', agent: 'codex', file, adds: ['notify → cw notify done'] };
}

/** The `notify =` key line, anywhere in the file — top-level or inside a [table]. */
function notifyKeyLine(text: string): string | undefined {
  for (const line of text.split('\n')) {
    if (/^\s*notify\s*=/.test(line)) return line;
  }
  return undefined;
}

/** The line crossweave wrote: our fixed tokens, whatever escaping or binary path. */
function oursNotifyLine(line: string): boolean {
  return line.includes('notify --kind done') && line.includes('finished its turn');
}

function insertTopLevelKey(text: string, line: string): string {
  const lines = text.split('\n');
  const sectionAt = lines.findIndex((l) => /^\s*\[/.test(l));
  if (sectionAt === -1) return `${text.replace(/\n*$/, '\n')}${line}\n`;
  lines.splice(sectionAt, 0, line);
  return lines.join('\n');
}

function removeCodexLine(text: string): string {
  const lines = text.split('\n');
  const index = lines.findIndex((l) => /^notify\s*=/.test(l) && oursNotifyLine(l));
  if (index === -1) return text;
  lines.splice(index, 1);
  return lines.join('\n');
}

// --- remove: claude -------------------------------------------------------

function removeClaude(opts: HooksOptions): HookRemoveOutcome {
  const io = opts.io ?? nodeHooksIo();
  const home = opts.home ?? homedir();
  const file = claudeSettingsPath(home);
  const raw = io.readText(file);
  if (raw === undefined) return { status: 'noop', agent: 'claude' };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { status: 'refused', agent: 'claude', code: 'AGENT_CONFIG_MALFORMED', message: `${file} is not valid JSON; fix it first` };
  }
  const hooks = parsed['hooks'];
  if (typeof hooks !== 'object' || hooks === null) return { status: 'noop', agent: 'claude' };
  const record = hooks as Record<string, unknown>;
  let removed = false;
  for (const event of ['Stop', 'Notification'] as const) {
    const list = record[event];
    if (!Array.isArray(list)) continue;
    // Match by our fixed argument string — whatever binary name install used (a source
    // checkout's `bun …` or a PATH `cw`) — so remove works across prefix changes.
    const args = event === 'Stop' ? DONE_NOTIFY_ARGS : ASK_NOTIFY_ARGS;
    const next: unknown[] = [];
    for (const item of list) {
      const entryHooks = (item as ClaudeHookEntry | null)?.hooks;
      if (!Array.isArray(entryHooks) || !entryHooks.some((h) => h?.command !== undefined && h.command.includes(args))) {
        next.push(item);
        continue;
      }
      removed = true;
      // An entry can bundle our hook with the user's own: strip only OUR commands,
      // and drop the entry once nothing but ours was in it.
      const kept = entryHooks.filter((h) => h?.command === undefined || !h.command.includes(args));
      if (kept.length > 0) next.push({ ...(item as ClaudeHookEntry), hooks: kept });
    }
    if (removed) {
      if (next.length === 0) delete record[event];
      else record[event] = next;
    }
  }
  if (!removed) return { status: 'noop', agent: 'claude' };
  if (Object.keys(record).length === 0) delete parsed['hooks'];
  else parsed['hooks'] = record;
  writeBack(io, file, raw, JSON.stringify(parsed, null, 2) + '\n', 'claude', 'removed cw notify entries', home);
  clearProvenance(io, join(globalCrossweaveDir(home), 'hooks-installed.json'), 'claude');
  return { status: 'ok', agent: 'claude', file };
}

function removeCodex(opts: HooksOptions): HookRemoveOutcome {
  const io = opts.io ?? nodeHooksIo();
  const home = opts.home ?? homedir();
  const file = codexConfigPath(home);
  const raw = io.readText(file);
  if (raw === undefined) return { status: 'noop', agent: 'codex' };
  if (notifyKeyLine(raw) === undefined) return { status: 'noop', agent: 'codex' };
  const next = removeCodexLine(raw);
  if (next === raw) return { status: 'noop', agent: 'codex' };
  writeBack(io, file, raw, next, 'codex', 'removed cw notify line', home);
  clearProvenance(io, join(globalCrossweaveDir(home), 'hooks-installed.json'), 'codex');
  return { status: 'ok', agent: 'codex', file };
}

// --- backup + provenance --------------------------------------------------

/**
 * One write per file per install run: back the original up (only if the file existed
 * before crossweave touched it), write atomically, record provenance.
 */
function writeBack(
  io: HooksIo, file: string, preflightRaw: string | undefined, content: string,
  agent: string, what: string, home: string,
): void {
  const global = globalCrossweaveDir(home);
  const backupDir = join(global, 'hooks-backup');
  io.mkdirs(backupDir);
  if (preflightRaw !== undefined) {
    io.backup(file, join(backupDir, `${agent}-${basename(file)}-${Date.now()}`));
  }
  io.writeTextAtomic(file, content);
  recordProvenance(io, join(global, 'hooks-installed.json'), agent, file, what);
}

/** After a successful remove: the agent leaves provenance entirely (nothing is ours). */
function clearProvenance(io: HooksIo, provenanceFile: string, agent: string): void {
  let record: Record<string, unknown> = {};
  const raw = io.readText(provenanceFile);
  if (raw !== undefined) {
    try {
      record = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
  }
  const agents = (record['agents'] ?? {}) as Record<string, unknown>;
  if (!(agent in agents)) return;
  delete agents[agent];
  record['agents'] = agents;
  io.writeTextAtomic(provenanceFile, JSON.stringify(record, null, 2) + '\n');
  io.chmodPrivate(provenanceFile);
}

function recordProvenance(io: HooksIo, provenanceFile: string, agent: string, file: string, what: string): void {
  let record: Record<string, unknown> = {};
  const raw = io.readText(provenanceFile);
  if (raw !== undefined) {
    try {
      record = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      record = {};
    }
  }
  const agents = (record['agents'] ?? {}) as Record<string, unknown>;
  const mine = (agents[agent] ?? {}) as Record<string, unknown>;
  const prior = Array.isArray(mine['added']) ? (mine['added'] as unknown[]).filter((s): s is string => typeof s === 'string') : [];
  const added = new Set([...prior, what]);
  agents[agent] = { file, added: [...added] };
  record['version'] = 1;
  record['agents'] = agents;
  io.writeTextAtomic(provenanceFile, JSON.stringify(record, null, 2) + '\n');
  io.chmodPrivate(provenanceFile);
}
