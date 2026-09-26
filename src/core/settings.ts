import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CrossweaveError } from './errors.js';
import { globalCrossweaveDir } from './paths.js';

/**
 * Per-USER settings: which agents exist and how they launch, which editor opens a
 * file, saved layouts. Deliberately never per repo — the daemon executes these
 * commands, and a cloned repository must not be able to declare what runs on the
 * user's machine (the per-repo testCommand needed a whole trust mechanism for that).
 */

export interface AgentDef {
  /** Stable id, stored on the session: lowercase letters, digits, dashes. */
  id: string;
  label: string;
  /** Launch command, split into argv by `splitCommand` — never run through a shell. */
  command: string;
  enabled: boolean;
  builtin: boolean;
}

export type EditorKind = 'vscode' | 'cursor' | 'zed' | 'custom';

export interface EditorSetting {
  kind: EditorKind;
  /** For `custom`: argv template; `{file}`, `{line}`, `{col}` are substituted. */
  command?: string;
}

export interface UserSettings {
  agents: AgentDef[];
  editor: EditorSetting;
  /** Named cockpit layouts, opaque to the daemon. */
  layouts: Record<string, unknown>;
}

/**
 * The agents shipped by default, each in its normal (asking) mode: a bypass flag such
 * as `--yolo` is the user's own edit to make, not a default.
 */
export const BUILTIN_AGENTS: readonly AgentDef[] = [
  { id: 'claude', label: 'Claude Code', command: 'claude', enabled: true, builtin: true },
  { id: 'codex', label: 'Codex', command: 'codex', enabled: true, builtin: true },
  { id: 'opencode', label: 'OpenCode', command: 'opencode', enabled: true, builtin: true },
  { id: 'gemini', label: 'Gemini CLI', command: 'gemini', enabled: true, builtin: true },
  { id: 'antigravity', label: 'Antigravity', command: 'agy', enabled: true, builtin: true },
];

const EDITORS: ReadonlySet<string> = new Set(['vscode', 'cursor', 'zed', 'custom']);
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Shell-style word splitting — quotes and backslash escapes — without a shell. */
export function splitCommand(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote !== null) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < command.length) cur += command[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; inWord = true; continue; }
    if (c === '\\' && i + 1 < command.length) { cur += command[++i]; inWord = true; continue; }
    if (/\s/.test(c)) {
      if (inWord) { out.push(cur); cur = ''; inWord = false; }
      continue;
    }
    cur += c;
    inWord = true;
  }
  if (quote !== null) throw new CrossweaveError('INVALID_COMMAND', `Unbalanced quote in command: ${command}`);
  if (inWord) out.push(cur);
  if (out.length === 0) throw new CrossweaveError('INVALID_COMMAND', 'Command is empty');
  return out;
}

/**
 * `$HOME` first, as POSIX tools do. Bun's `os.homedir()` ignores a changed `HOME`, so
 * falling straight to it made the tests that point `HOME` at a temp dir write the
 * developer's real settings file instead.
 */
function homeFor(homeDir?: string): string | undefined {
  return homeDir ?? (process.env.HOME || undefined);
}

function settingsPath(homeDir?: string): string {
  return join(globalCrossweaveDir(homeFor(homeDir)), 'settings.json');
}

function validate(settings: UserSettings): void {
  const seen = new Set<string>();
  for (const agent of settings.agents) {
    if (typeof agent.id !== 'string' || !AGENT_ID.test(agent.id)) {
      throw new CrossweaveError('INVALID_SETTINGS', `Invalid agent id "${String(agent.id)}": use lowercase letters, digits and dashes`);
    }
    if (seen.has(agent.id)) throw new CrossweaveError('INVALID_SETTINGS', `Duplicate agent id: ${agent.id}`);
    seen.add(agent.id);
    if (typeof agent.label !== 'string' || agent.label.trim() === '') {
      throw new CrossweaveError('INVALID_SETTINGS', `Agent ${agent.id} needs a label`);
    }
    splitCommand(agent.command);
    if (typeof agent.enabled !== 'boolean') throw new CrossweaveError('INVALID_SETTINGS', `Agent ${agent.id}: enabled must be true or false`);
  }
  if (!EDITORS.has(settings.editor?.kind)) {
    throw new CrossweaveError('INVALID_SETTINGS', `Unknown editor: ${String(settings.editor?.kind)}`);
  }
  if (settings.editor.kind === 'custom') {
    if (typeof settings.editor.command !== 'string') throw new CrossweaveError('INVALID_SETTINGS', 'A custom editor needs a command');
    splitCommand(settings.editor.command);
  }
}

/**
 * Saved settings over the built-ins: a saved entry with a built-in's id overrides its
 * command/enabled/label; anything else is a custom agent, kept in saved order after
 * the built-ins. A missing or corrupt file means defaults — this is read on every
 * session start, and a bad file must not break unrelated commands.
 */
export function loadSettings(homeDir?: string): UserSettings {
  let saved: Partial<UserSettings> = {};
  const path = settingsPath(homeDir);
  if (existsSync(path)) {
    try {
      saved = JSON.parse(readFileSync(path, 'utf8')) as Partial<UserSettings>;
    } catch {
      saved = {};
    }
  }
  const savedAgents = Array.isArray(saved.agents) ? saved.agents : [];
  const byId = new Map(savedAgents.map((a) => [a.id, a]));
  const builtins = BUILTIN_AGENTS.map((b) => {
    const o = byId.get(b.id);
    return o === undefined ? { ...b } : {
      ...b,
      label: typeof o.label === 'string' && o.label.trim() !== '' ? o.label : b.label,
      command: typeof o.command === 'string' && o.command.trim() !== '' ? o.command : b.command,
      enabled: typeof o.enabled === 'boolean' ? o.enabled : b.enabled,
    };
  });
  const builtinIds = new Set(BUILTIN_AGENTS.map((b) => b.id));
  const customs = savedAgents
    .filter((a) => !builtinIds.has(a.id) && typeof a.id === 'string' && AGENT_ID.test(a.id)
      && typeof a.command === 'string' && a.command.trim() !== '')
    .map((a) => ({ id: a.id, label: a.label || a.id, command: a.command, enabled: a.enabled !== false, builtin: false }));
  const editor = saved.editor && EDITORS.has(saved.editor.kind) ? saved.editor : { kind: 'vscode' as const };
  const layouts = saved.layouts && typeof saved.layouts === 'object' ? saved.layouts : {};
  return { agents: [...builtins, ...customs], editor, layouts };
}

/** Validate, then write atomically (temp + rename), readable by the user only. */
export function saveSettings(settings: UserSettings, homeDir?: string): void {
  validate(settings);
  const dir = globalCrossweaveDir(homeFor(homeDir));
  mkdirSync(dir, { recursive: true });
  const path = settingsPath(homeDir);
  const tmp = `${path}.${process.pid}.tmp`;
  const normalized: UserSettings = {
    agents: settings.agents.map(({ id, label, command, enabled, builtin }) => ({ id, label, command, enabled, builtin })),
    editor: settings.editor,
    layouts: settings.layouts ?? {},
  };
  writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
