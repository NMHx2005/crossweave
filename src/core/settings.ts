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

export interface TerminalColors {
  background: string;
  foreground: string;
  cursor?: string;
  cursorText?: string;
  selection?: string;
  /** ANSI 0-15, or none to keep the cockpit's. */
  ansi?: string[];
}

/**
 * How the cockpit's terminal panes look, usually imported from the user's own
 * terminal (Ghostty, iTerm2). Absent: the cockpit's palette and font.
 */
export interface TerminalAppearance {
  fontFamily?: string;
  fontSize?: number;
  cursorStyle?: 'block' | 'bar' | 'underline';
  cursorBlink?: boolean;
  /** Option sends Meta (Esc+), as in the terminal it came from. */
  optionAsMeta?: boolean;
  colors?: TerminalColors;
  importedFrom?: 'ghostty' | 'iterm2';
}

/** The cockpit window's own fonts and text size (the terminal panes have `terminal`). */
export interface InterfaceAppearance {
  /** Sidebar, menus, dialogs. Absent: the system font. */
  uiFont?: string;
  /** Commands, paths, branches, the file editor. Absent: the cockpit's monospace. */
  codeFont?: string;
  textSize?: 'small' | 'default' | 'large';
}

/** USD per million tokens, for one model. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/**
 * Token usage on the rail. The agents' logs carry tokens, not money, and prices change,
 * so cost is shown only for models the user has priced.
 */
export interface UsageSettings {
  show?: boolean;
  prices?: Record<string, ModelPrice>;
}

export interface UserSettings {
  launchers: LauncherDef[];
  editor: EditorSetting;
  /** Named cockpit layouts, opaque to the daemon. */
  layouts: Record<string, unknown>;
  terminal?: TerminalAppearance;
  appearance?: InterfaceAppearance;
  usage?: UsageSettings;
}

/** A font family as it reaches xterm's CSS font string: nothing that could end the quotes. */
const FONT_FAMILY = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,79}$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Whether `name` can be stored as a font family (see FONT_FAMILY). */
export function isFontFamilyName(name: string): boolean {
  return FONT_FAMILY.test(name);
}
const CURSOR_STYLES: ReadonlySet<string> = new Set(['block', 'bar', 'underline']);
const TERMINAL_SOURCES: ReadonlySet<string> = new Set(['ghostty', 'iterm2']);

/**
 * `raw` reduced to what is valid, and what was not. Load keeps the valid part (a bad
 * file must not cost the rest); save refuses on any problem.
 */
export function cleanTerminal(raw: unknown): { terminal: TerminalAppearance | undefined; problems: string[] } {
  const problems: string[] = [];
  if (raw === undefined || raw === null) return { terminal: undefined, problems };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { terminal: undefined, problems: ['terminal must be an object'] };
  const r = raw as Record<string, unknown>;
  const out: TerminalAppearance = {};
  if (r.fontFamily !== undefined) {
    if (typeof r.fontFamily === 'string' && FONT_FAMILY.test(r.fontFamily)) out.fontFamily = r.fontFamily;
    else problems.push('terminal font family: letters, digits, spaces and ._+- only, up to 80 characters');
  }
  if (r.fontSize !== undefined) {
    if (typeof r.fontSize === 'number' && Number.isInteger(r.fontSize) && r.fontSize >= 8 && r.fontSize <= 32) out.fontSize = r.fontSize;
    else problems.push('terminal font size: a whole number from 8 to 32');
  }
  if (r.cursorStyle !== undefined) {
    if (typeof r.cursorStyle === 'string' && CURSOR_STYLES.has(r.cursorStyle)) out.cursorStyle = r.cursorStyle as TerminalAppearance['cursorStyle'];
    else problems.push('terminal cursor: block, bar or underline');
  }
  for (const key of ['cursorBlink', 'optionAsMeta'] as const) {
    if (r[key] === undefined) continue;
    if (typeof r[key] === 'boolean') out[key] = r[key] as boolean;
    else problems.push(`terminal ${key} must be true or false`);
  }
  if (r.importedFrom !== undefined) {
    if (typeof r.importedFrom === 'string' && TERMINAL_SOURCES.has(r.importedFrom)) out.importedFrom = r.importedFrom as TerminalAppearance['importedFrom'];
    else problems.push('terminal importedFrom: ghostty or iterm2');
  }
  if (r.colors !== undefined) {
    const c = r.colors as Record<string, unknown> | null;
    const hex = (v: unknown): v is string => typeof v === 'string' && HEX_COLOR.test(v);
    const ok = c !== null && typeof c === 'object' && !Array.isArray(c)
      && hex(c.background) && hex(c.foreground)
      && ['cursor', 'cursorText', 'selection'].every((k) => c[k] === undefined || hex(c[k]))
      && (c.ansi === undefined || (Array.isArray(c.ansi) && c.ansi.length === 16 && c.ansi.every(hex)));
    if (ok) {
      const colors: TerminalColors = { background: c.background as string, foreground: c.foreground as string };
      for (const k of ['cursor', 'cursorText', 'selection'] as const) if (c[k] !== undefined) colors[k] = c[k] as string;
      if (c.ansi !== undefined) colors.ansi = [...(c.ansi as string[])];
      out.colors = colors;
    } else {
      problems.push('terminal colors: #rrggbb values, and 16 ANSI colors or none');
    }
  }
  return { terminal: Object.keys(out).length === 0 ? undefined : out, problems };
}

const TEXT_SIZES: ReadonlySet<string> = new Set(['small', 'default', 'large']);

/** Like cleanTerminal: the valid part, and what was not. */
export function cleanAppearance(raw: unknown): { appearance: InterfaceAppearance | undefined; problems: string[] } {
  const problems: string[] = [];
  if (raw === undefined || raw === null) return { appearance: undefined, problems };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { appearance: undefined, problems: ['appearance must be an object'] };
  const r = raw as Record<string, unknown>;
  const out: InterfaceAppearance = {};
  for (const key of ['uiFont', 'codeFont'] as const) {
    if (r[key] === undefined) continue;
    // Set as a CSS custom property on the whole window: nothing that ends a value.
    if (typeof r[key] === 'string' && FONT_FAMILY.test(r[key] as string)) out[key] = r[key] as string;
    else problems.push(`appearance ${key === 'uiFont' ? 'interface' : 'code'} font: letters, digits, spaces and ._+- only, up to 80 characters`);
  }
  if (r.textSize !== undefined) {
    if (typeof r.textSize === 'string' && TEXT_SIZES.has(r.textSize)) out.textSize = r.textSize as InterfaceAppearance['textSize'];
    else problems.push('appearance text size: small, default or large');
  }
  return { appearance: Object.keys(out).length === 0 ? undefined : out, problems };
}

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,79}$/;
const PRICE_KINDS = ['input', 'output', 'cacheWrite', 'cacheRead'] as const;

export function cleanUsage(raw: unknown): { usage: UsageSettings | undefined; problems: string[] } {
  const problems: string[] = [];
  if (raw === undefined || raw === null) return { usage: undefined, problems };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { usage: undefined, problems: ['usage must be an object'] };
  const r = raw as Record<string, unknown>;
  const out: UsageSettings = {};
  if (r.show !== undefined) {
    if (typeof r.show === 'boolean') out.show = r.show;
    else problems.push('usage show must be true or false');
  }
  if (r.prices !== undefined) {
    if (typeof r.prices !== 'object' || r.prices === null || Array.isArray(r.prices)) {
      problems.push('usage prices must map a model to its prices');
    } else {
      const prices: Record<string, ModelPrice> = {};
      for (const [model, value] of Object.entries(r.prices as Record<string, unknown>)) {
        const p = value as Record<string, unknown> | null;
        const ok = MODEL_NAME.test(model) && p !== null && typeof p === 'object'
          && PRICE_KINDS.every((k) => typeof p[k] === 'number' && Number.isFinite(p[k]) && (p[k] as number) >= 0 && (p[k] as number) <= 10_000);
        if (ok) prices[model] = { input: p.input as number, output: p.output as number, cacheWrite: p.cacheWrite as number, cacheRead: p.cacheRead as number };
        else problems.push(`usage price for "${model}": a model name, and four prices from 0 to 10000 USD per million tokens`);
      }
      if (Object.keys(prices).length > 0) out.prices = prices;
    }
  }
  return { usage: Object.keys(out).length === 0 ? undefined : out, problems };
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
  const problems = [
    ...cleanTerminal(settings.terminal).problems,
    ...cleanAppearance(settings.appearance).problems,
    ...cleanUsage(settings.usage).problems,
  ];
  if (problems.length > 0) invalid(problems[0] as string);
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
  const { terminal } = cleanTerminal(saved.terminal);
  const { appearance } = cleanAppearance(saved.appearance);
  const { usage } = cleanUsage(saved.usage);
  return {
    launchers: mergeLaunchers(saved.launchers), editor, layouts,
    ...(terminal === undefined ? {} : { terminal }),
    ...(appearance === undefined ? {} : { appearance }),
    ...(usage === undefined ? {} : { usage }),
  };
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
    ...(settings.terminal === undefined ? {} : { terminal: cleanTerminal(settings.terminal).terminal }),
    ...(settings.appearance === undefined ? {} : { appearance: cleanAppearance(settings.appearance).appearance }),
    ...(settings.usage === undefined ? {} : { usage: cleanUsage(settings.usage).usage }),
  };
  writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
