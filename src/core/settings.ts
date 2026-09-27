import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { splitCommand } from './argv.js';
import { CrossweaveError } from './errors.js';
import { globalCrossweaveDir } from './paths.js';

/**
 * Per-USER settings: the launchers a new session can start with, which editor opens
 * a file, and saved layouts. Deliberately never per repo — these are commands run on
 * the user's machine, and a cloned repository must not be able to declare them (the
 * per-repo testCommand needed a whole trust mechanism for that). An `agents` list left
 * by an older version is ignored.
 */

/**
 * A command typed into a new session's shell — `claude --model opus`, a `cx` wrapper —
 * with extra environment for that shell. It runs INSIDE the shell, so when it exits
 * the user is back at a prompt in the worktree, as in a terminal multiplexer.
 * Starting a plain Terminal is no launcher at all.
 */
export interface LauncherDef {
  /** Stable id: lowercase letters, digits, dashes. */
  id: string;
  label: string;
  /** One line, typed into the shell as-is (the shell parses it). */
  command: string;
  /** Extra environment for the session's shell. */
  env: Record<string, string>;
  enabled: boolean;
  builtin: boolean;
}

/** The popular agent CLIs, each in its plain form; flags are the user's edit to make. */
export const BUILTIN_LAUNCHERS: readonly LauncherDef[] = [
  { id: 'claude', label: 'Claude Code', command: 'claude', env: {}, enabled: true, builtin: true },
  { id: 'codex', label: 'Codex', command: 'codex', env: {}, enabled: true, builtin: true },
  { id: 'gemini', label: 'Gemini CLI', command: 'gemini', env: {}, enabled: true, builtin: true },
  { id: 'opencode', label: 'OpenCode', command: 'opencode', env: {}, enabled: true, builtin: true },
  { id: 'cursor', label: 'Cursor Agent', command: 'cursor-agent', env: {}, enabled: true, builtin: true },
  { id: 'copilot', label: 'GitHub Copilot CLI', command: 'copilot', env: {}, enabled: true, builtin: true },
  { id: 'aider', label: 'Aider', command: 'aider', env: {}, enabled: true, builtin: true },
  { id: 'amp', label: 'Amp', command: 'amp', env: {}, enabled: true, builtin: true },
  { id: 'qwen', label: 'Qwen Code', command: 'qwen', env: {}, enabled: true, builtin: true },
];

/** `cockpit`: Cmd+click opens the file in the cockpit's own editor pane. */
export type EditorKind = 'vscode' | 'cursor' | 'zed' | 'custom' | 'cockpit';

export interface EditorSetting {
  kind: EditorKind;
  /** For `custom`: argv template; `{file}`, `{line}`, `{col}` are substituted. */
  command?: string;
}

export interface UserSettings {
  launchers: LauncherDef[];
  editor: EditorSetting;
  /** Named cockpit layouts, opaque to the daemon. */
  layouts: Record<string, unknown>;
}

const EDITORS: ReadonlySet<string> = new Set(['vscode', 'cursor', 'zed', 'custom', 'cockpit']);
const LAUNCHER_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_COMMAND = 2000;
const MAX_ENV = 50;
const MAX_ENV_VALUE = 4096;


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

function invalid(message: string): never {
  throw new CrossweaveError('INVALID_SETTINGS', message);
}

function validateLauncher(l: LauncherDef, seen: Set<string>): void {
  if (typeof l.id !== 'string' || !LAUNCHER_ID.test(l.id)) invalid(`Invalid launcher id "${String(l.id)}": use lowercase letters, digits and dashes`);
  // "terminal" is the choice of no launcher, never a launcher's name.
  if (l.id === 'terminal') invalid('"terminal" is reserved for a plain shell');
  if (seen.has(l.id)) invalid(`Duplicate launcher id: ${l.id}`);
  seen.add(l.id);
  if (typeof l.label !== 'string' || l.label.trim() === '' || l.label.length > 60) invalid(`Launcher ${l.id} needs a label of 1-60 characters`);
  if (typeof l.command !== 'string' || l.command.trim() === '') invalid(`Launcher ${l.id} needs a command`);
  if (l.command.length > MAX_COMMAND) invalid(`Launcher ${l.id}: the command is longer than ${MAX_COMMAND} characters`);
  // Typed into a shell: a line break would run a second command.
  if (/[\r\n\0]/.test(l.command)) invalid(`Launcher ${l.id}: the command must be one line`);
  if (typeof l.enabled !== 'boolean') invalid(`Launcher ${l.id}: enabled must be true or false`);
  if (typeof l.env !== 'object' || l.env === null || Array.isArray(l.env)) invalid(`Launcher ${l.id}: env must be an object`);
  const entries = Object.entries(l.env);
  if (entries.length > MAX_ENV) invalid(`Launcher ${l.id}: at most ${MAX_ENV} environment variables`);
  for (const [key, value] of entries) {
    if (!ENV_NAME.test(key)) invalid(`Launcher ${l.id}: "${key}" is not a variable name`);
    if (typeof value !== 'string' || value.length > MAX_ENV_VALUE || /[\r\n\0]/.test(value)) {
      invalid(`Launcher ${l.id}: ${key} must be one line of at most ${MAX_ENV_VALUE} characters`);
    }
  }
}

function validate(settings: UserSettings): void {
  if (!Array.isArray(settings.launchers)) invalid('launchers must be a list');
  const seen = new Set<string>();
  for (const l of settings.launchers) validateLauncher(l, seen);
  if (!EDITORS.has(settings.editor?.kind)) {
    throw new CrossweaveError('INVALID_SETTINGS', `Unknown editor: ${String(settings.editor?.kind)}`);
  }
  if (settings.editor.kind === 'custom') {
    if (typeof settings.editor.command !== 'string') throw new CrossweaveError('INVALID_SETTINGS', 'A custom editor needs a command');
    splitCommand(settings.editor.command);
  }
}

/**
 * The saved settings over the defaults. A missing or corrupt file means defaults: a
 * bad file must not break unrelated commands.
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
  const editor = saved.editor && EDITORS.has(saved.editor.kind) ? saved.editor : { kind: 'vscode' as const };
  const layouts = saved.layouts && typeof saved.layouts === 'object' ? saved.layouts : {};
  return { launchers: mergeLaunchers(saved.launchers), editor, layouts };
}

function stringEnv(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) if (ENV_NAME.test(k) && typeof v === 'string') out[k] = v;
  return out;
}

/**
 * Saved launchers over the built-ins: a saved entry with a built-in's id overrides its
 * label/command/env/enabled; anything else is a custom launcher, kept in saved order
 * after the built-ins. Malformed entries are dropped rather than breaking the list.
 */
function mergeLaunchers(saved: unknown): LauncherDef[] {
  const list = Array.isArray(saved) ? saved as Array<Partial<LauncherDef>> : [];
  const byId = new Map(list.filter((l) => typeof l?.id === 'string').map((l) => [l.id as string, l]));
  const builtins = BUILTIN_LAUNCHERS.map((b) => {
    const o = byId.get(b.id);
    if (o === undefined) return { ...b, env: {} };
    return {
      ...b,
      label: typeof o.label === 'string' && o.label.trim() !== '' ? o.label : b.label,
      command: typeof o.command === 'string' && o.command.trim() !== '' && !/[\r\n\0]/.test(o.command) ? o.command : b.command,
      env: stringEnv(o.env),
      enabled: typeof o.enabled === 'boolean' ? o.enabled : b.enabled,
    };
  });
  const builtinIds = new Set(BUILTIN_LAUNCHERS.map((b) => b.id));
  const customs = list
    .filter((l) => typeof l.id === 'string' && LAUNCHER_ID.test(l.id) && l.id !== 'terminal' && !builtinIds.has(l.id)
      && typeof l.command === 'string' && l.command.trim() !== '' && !/[\r\n\0]/.test(l.command))
    .map((l) => ({
      id: l.id as string,
      label: typeof l.label === 'string' && l.label.trim() !== '' ? l.label : l.id as string,
      command: l.command as string,
      env: stringEnv(l.env),
      enabled: l.enabled !== false,
      builtin: false,
    }));
  return [...builtins, ...customs];
}

/** Validate, then write atomically (temp + rename), readable by the user only. */
export function saveSettings(settings: UserSettings, homeDir?: string): void {
  validate(settings);
  const dir = globalCrossweaveDir(homeFor(homeDir));
  mkdirSync(dir, { recursive: true });
  const path = settingsPath(homeDir);
  const tmp = `${path}.${process.pid}.tmp`;
  const normalized: UserSettings = {
    launchers: settings.launchers.map(({ id, label, command, env, enabled, builtin }) => ({ id, label, command, env, enabled, builtin })),
    editor: settings.editor,
    layouts: settings.layouts ?? {},
  };
  writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
