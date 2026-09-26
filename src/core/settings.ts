import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { splitCommand } from './argv.js';
import { CrossweaveError } from './errors.js';
import { globalCrossweaveDir } from './paths.js';

/**
 * Per-USER settings: which editor opens a file, and saved layouts. Deliberately never
 * per repo — a custom editor is a command crossweave runs, and a cloned repository
 * must not be able to declare what runs on the user's machine (the per-repo
 * testCommand needed a whole trust mechanism for that). An `agents` list left in an
 * older settings file is ignored: crossweave no longer launches agents.
 */

/** `cockpit`: Cmd+click opens the file in the cockpit's own editor pane. */
export type EditorKind = 'vscode' | 'cursor' | 'zed' | 'custom' | 'cockpit';

export interface EditorSetting {
  kind: EditorKind;
  /** For `custom`: argv template; `{file}`, `{line}`, `{col}` are substituted. */
  command?: string;
}

export interface UserSettings {
  editor: EditorSetting;
  /** Named cockpit layouts, opaque to the daemon. */
  layouts: Record<string, unknown>;
}

const EDITORS: ReadonlySet<string> = new Set(['vscode', 'cursor', 'zed', 'custom', 'cockpit']);


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
  return { editor, layouts };
}

/** Validate, then write atomically (temp + rename), readable by the user only. */
export function saveSettings(settings: UserSettings, homeDir?: string): void {
  validate(settings);
  const dir = globalCrossweaveDir(homeFor(homeDir));
  mkdirSync(dir, { recursive: true });
  const path = settingsPath(homeDir);
  const tmp = `${path}.${process.pid}.tmp`;
  const normalized: UserSettings = {
    editor: settings.editor,
    layouts: settings.layouts ?? {},
  };
  writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
