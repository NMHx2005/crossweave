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
  /** The window's colors: follow macOS, Dark, Light, or derived from the imported terminal colors. */
  theme?: 'system' | 'dark' | 'light' | 'terminal';
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

/**
 * What the daemon may keep at rest. Off by default: a terminal snapshot is output, which can
 * hold anything a person typed or printed, so keeping it is something the user asks for.
 */
export interface PersistenceSettings {
  /** Reopen extra terminals after a daemon restart, with the tail of their output. */
  terminals?: boolean;
}

/**
 * The prompt composer. Refining a draft is done by a program the user names (the app does not choose an AI):
 * one line, split into arguments without a shell, the draft on its stdin. Unset means no Refine button.
 */
export interface PromptSettings {
  refine?: {
    command?: string;
    /** What the command is told to do; empty falls back to the app's default. */
    instruction?: string;
    /** Add the session's name, branch and changed-file count to what the command reads. */
    includeContext?: boolean;
  };
}

/**
 * A one-click way to start a session: which launcher, an own worktree or not, shells to open beside it with a
 * command typed and run in each, and a Browser pane on the session's leased port. They live in the USER's own
 * settings file (not the repository's), so the commands are the person's own — unlike a repository's hooks, nothing
 * here arrives from a clone and needs a trust step.
 */
export interface SessionPreset {
  name: string;
  /** A launcher id from Settings; absent means a plain terminal. */
  launcher?: string;
  /** Own worktree (default true). */
  worktree?: boolean;
  /** One command per extra terminal, typed and run in order. */
  terminals?: string[];
  /** Open a Browser pane on the session's leased port, at this path (default `/`). */
  browser?: { path?: string };
}

export interface UserSettings {
  launchers: LauncherDef[];
  editor: EditorSetting;
  /** Named cockpit layouts, opaque to the daemon. */
  layouts: Record<string, unknown>;
  terminal?: TerminalAppearance;
  appearance?: InterfaceAppearance;
  usage?: UsageSettings;
  /**
   * The cockpit's shortcuts over its defaults: command id → Electron accelerator, or
   * null to unbind. The cockpit checks the grammar and conflicts; this checks shape.
   */
  keybindings?: Record<string, string | null>;
  persistence?: PersistenceSettings;
  prompt?: PromptSettings;
  presets?: SessionPreset[];
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
const THEMES: ReadonlySet<string> = new Set(['system', 'dark', 'light', 'terminal']);

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
  if (r.theme !== undefined) {
    if (typeof r.theme === 'string' && THEMES.has(r.theme)) out.theme = r.theme as InterfaceAppearance['theme'];
    else problems.push('appearance theme: system, dark, light or terminal');
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

const COMMAND_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ACCELERATOR_CHARS = /^[A-Za-z0-9+,./;'[\]\\\-=`]{1,40}$/;
/** A key-table binding: the prefix, then one character or a named key (`prefix:%`, `prefix:Left`). */
const PREFIX_BINDING = /^prefix:(?:[^\s\p{C}]|Space|Left|Right|Up|Down|Enter|Escape|Tab|Backspace)$/u;

export function cleanKeybindings(raw: unknown): { keybindings: Record<string, string | null> | undefined; problems: string[] } {
  const problems: string[] = [];
  if (raw === undefined || raw === null) return { keybindings: undefined, problems };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { keybindings: undefined, problems: ['keybindings must map a command to a shortcut'] };
  const out: Record<string, string | null> = {};
  for (const [id, key] of Object.entries(raw as Record<string, unknown>)) {
    if (COMMAND_ID.test(id) && (key === null || (typeof key === 'string' && (ACCELERATOR_CHARS.test(key) || PREFIX_BINDING.test(key))))) out[id] = key;
    else problems.push(`keybinding "${id}": a command id, and a shortcut like CmdOrCtrl+Shift+K (or none)`);
  }
  return { keybindings: Object.keys(out).length === 0 ? undefined : out, problems };
}

const MAX_PROMPT_COMMAND = 2000;
const MAX_PROMPT_INSTRUCTION = 4000;

export function cleanPrompt(raw: unknown): { prompt: PromptSettings | undefined; problems: string[] } {
  const problems: string[] = [];
  if (raw === undefined || raw === null) return { prompt: undefined, problems };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { prompt: undefined, problems: ['prompt must be an object'] };
  const refineRaw = (raw as Record<string, unknown>).refine;
  if (refineRaw === undefined) return { prompt: undefined, problems };
  if (typeof refineRaw !== 'object' || refineRaw === null || Array.isArray(refineRaw)) {
    return { prompt: undefined, problems: ['prompt refine must be an object'] };
  }
  const f = refineRaw as Record<string, unknown>;
  const refine: NonNullable<PromptSettings['refine']> = {};
  if (f.command !== undefined) {
    if (typeof f.command !== 'string') problems.push('prompt refine command must be text');
    else if (f.command.length > MAX_PROMPT_COMMAND || /[\r\n\0]/.test(f.command)) {
      problems.push(`prompt refine command must be one line of at most ${MAX_PROMPT_COMMAND} characters`);
    } else if (f.command.trim() !== '') {
      try {
        splitCommand(f.command);
        refine.command = f.command;
      } catch {
        problems.push('prompt refine command: unbalanced quote');
      }
    }
  }
  if (f.instruction !== undefined) {
    if (typeof f.instruction === 'string' && f.instruction.length <= MAX_PROMPT_INSTRUCTION && !f.instruction.includes('\0')) {
      if (f.instruction.trim() !== '') refine.instruction = f.instruction;
    } else {
      problems.push(`prompt refine instruction: text of at most ${MAX_PROMPT_INSTRUCTION} characters`);
    }
  }
  if (f.includeContext !== undefined) {
    if (typeof f.includeContext === 'boolean') refine.includeContext = f.includeContext;
    else problems.push('prompt refine includeContext must be true or false');
  }
  return { prompt: Object.keys(refine).length === 0 ? undefined : { refine }, problems };
}

const MAX_PRESETS = 12;
const MAX_PRESET_NAME = 40;
const MAX_PRESET_TERMINALS = 4;
const MAX_PRESET_COMMAND = 500;
const MAX_PRESET_PATH = 200;

export function cleanPresets(raw: unknown): { presets: SessionPreset[] | undefined; problems: string[] } {
  const problems: string[] = [];
  if (raw === undefined || raw === null) return { presets: undefined, problems };
  if (!Array.isArray(raw)) return { presets: undefined, problems: ['presets must be a list'] };
  if (raw.length > MAX_PRESETS) problems.push(`presets: at most ${MAX_PRESETS}`);
  const out: SessionPreset[] = [];
  const seen = new Set<string>();
  for (const item of (raw as unknown[]).slice(0, MAX_PRESETS)) {
    const r = item as Record<string, unknown> | null;
    if (r === null || typeof r !== 'object' || Array.isArray(r)) { problems.push('preset must be an object'); continue; }
    const before = problems.length;
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    if (name === '' || name.length > MAX_PRESET_NAME || /[\x00-\x1f\x7f]/.test(name)) problems.push(`preset name: one line of 1 to ${MAX_PRESET_NAME} characters`);
    else if (seen.has(name)) problems.push(`preset name "${name}" is used twice`);
    const preset: SessionPreset = { name };
    if (r.launcher !== undefined) {
      if (typeof r.launcher === 'string' && LAUNCHER_ID.test(r.launcher)) preset.launcher = r.launcher;
      else problems.push(`preset "${name}" launcher must be a launcher id`);
    }
    if (r.worktree !== undefined) {
      if (typeof r.worktree === 'boolean') preset.worktree = r.worktree;
      else problems.push(`preset "${name}" worktree must be true or false`);
    }
    if (r.terminals !== undefined) {
      if (!Array.isArray(r.terminals) || r.terminals.length > MAX_PRESET_TERMINALS) problems.push(`preset "${name}" terminals: a list of at most ${MAX_PRESET_TERMINALS} commands`);
      else if (!(r.terminals as unknown[]).every((c) => typeof c === 'string' && c.trim() !== '' && c.length <= MAX_PRESET_COMMAND && !/[\x00-\x1f\x7f]/.test(c))) {
        problems.push(`preset "${name}" terminal commands: one plain line each, up to ${MAX_PRESET_COMMAND} characters`);
      } else if (r.terminals.length > 0) preset.terminals = (r.terminals as string[]).map((c) => c.trim());
    }
    if (r.browser !== undefined) {
      const b = r.browser as Record<string, unknown> | null;
      const path = b === null || typeof b !== 'object' || Array.isArray(b) ? undefined : b.path;
      if (b === null || typeof b !== 'object' || Array.isArray(b)) problems.push(`preset "${name}" browser must be an object`);
      else if (path === undefined) preset.browser = {};
      else if (typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && path.length <= MAX_PRESET_PATH && !/[\s\x00-\x1f\x7f]/.test(path)) preset.browser = { path };
      else problems.push(`preset "${name}" browser path: starts with a single /, no spaces, up to ${MAX_PRESET_PATH} characters`);
    }
    if (problems.length === before) { seen.add(name); out.push(preset); }
  }
  return { presets: out.length === 0 ? undefined : out, problems };
}

export function cleanPersistence(raw: unknown): { persistence: PersistenceSettings | undefined; problems: string[] } {
  if (raw === undefined || raw === null) return { persistence: undefined, problems: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { persistence: undefined, problems: ['persistence must be an object'] };
  const r = raw as Record<string, unknown>;
  const problems: string[] = [];
  const out: PersistenceSettings = {};
  if (r.terminals !== undefined) {
    if (typeof r.terminals === 'boolean') out.terminals = r.terminals;
    else problems.push('persistence terminals must be true or false');
  }
  return { persistence: Object.keys(out).length === 0 ? undefined : out, problems };
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
    ...cleanKeybindings(settings.keybindings).problems,
    ...cleanPersistence(settings.persistence).problems,
    ...cleanPrompt(settings.prompt).problems,
    ...cleanPresets(settings.presets).problems,
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
  const { keybindings } = cleanKeybindings(saved.keybindings);
  const { persistence } = cleanPersistence(saved.persistence);
  const { prompt } = cleanPrompt(saved.prompt);
  const { presets } = cleanPresets(saved.presets);
  return {
    launchers: mergeLaunchers(saved.launchers), editor, layouts,
    ...(terminal === undefined ? {} : { terminal }),
    ...(appearance === undefined ? {} : { appearance }),
    ...(usage === undefined ? {} : { usage }),
    ...(keybindings === undefined ? {} : { keybindings }),
    ...(persistence === undefined ? {} : { persistence }),
    ...(prompt === undefined ? {} : { prompt }),
    ...(presets === undefined ? {} : { presets }),
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
    ...(settings.keybindings === undefined ? {} : { keybindings: cleanKeybindings(settings.keybindings).keybindings }),
    ...(settings.persistence === undefined ? {} : { persistence: cleanPersistence(settings.persistence).persistence }),
    ...(settings.prompt === undefined ? {} : { prompt: cleanPrompt(settings.prompt).prompt }),
    ...(settings.presets === undefined ? {} : { presets: cleanPresets(settings.presets).presets }),
  };
  writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
