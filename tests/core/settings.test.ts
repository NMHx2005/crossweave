import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings, saveSettings } from '../../src/core/settings.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cw-settings-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const file = () => join(home, '.crossweave', 'settings.json');

describe('loadSettings', () => {
  it('defaults to VS Code and no layouts when nothing is saved', () => {
    expect(loadSettings(home)).toMatchObject({ editor: { kind: 'vscode' }, layouts: {} });
  });

  it('reads a saved editor and layouts', () => {
    saveSettings({ ...loadSettings(home), editor: { kind: 'zed' }, layouts: { review: { tabs: [] } } }, home);
    expect(loadSettings(home)).toMatchObject({ editor: { kind: 'zed' }, layouts: { review: { tabs: [] } } });
  });

  // crossweave no longer launches agents; an older file's agent list must not break
  // loading, and is dropped on the next save.
  it('ignores an agents list left by an older version', () => {
    mkdirSync(join(home, '.crossweave'), { recursive: true });
    writeFileSync(file(), JSON.stringify({ agents: [{ id: 'claude', command: 'claude' }], editor: { kind: 'cursor' } }));
    const s = loadSettings(home);
    expect(s).toMatchObject({ editor: { kind: 'cursor' }, layouts: {} });
    saveSettings(s, home);
    expect(JSON.parse(readFileSync(file(), 'utf8'))).not.toHaveProperty('agents');
  });

  it('falls back to defaults for a corrupt file rather than breaking every command', () => {
    mkdirSync(join(home, '.crossweave'), { recursive: true });
    writeFileSync(file(), '{not json');
    expect(loadSettings(home).editor).toEqual({ kind: 'vscode' });
  });
});

describe('saveSettings', () => {
  it('refuses an unknown editor, and a custom editor without a usable command', () => {
    expect(() => saveSettings({ ...loadSettings(home), editor: { kind: 'emacs' as never } }, home)).toThrow(/editor/i);
    expect(() => saveSettings({ ...loadSettings(home), editor: { kind: 'custom' } }, home)).toThrow(/editor/i);
    expect(() => saveSettings({ ...loadSettings(home), editor: { kind: 'custom', command: 'subl "{file}' } }, home)).toThrow(/quote/i);
  });

  it('writes a file only the user can read', () => {
    saveSettings(loadSettings(home), home);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
  });
});

describe('launchers', () => {
  // A launcher is a command typed into the session's shell; the Terminal choice is
  // simply none. The popular agent CLIs ship built in, each editable.
  it('ships the popular agent CLIs, enabled, with their plain commands', () => {
    const s = loadSettings(home);
    expect(s.launchers.map((l) => l.id)).toEqual(['claude', 'codex', 'gemini', 'opencode', 'cursor', 'copilot', 'aider', 'amp', 'qwen']);
    expect(s.launchers.find((l) => l.id === 'claude')).toMatchObject({ command: 'claude', env: {}, enabled: true, builtin: true });
  });

  it('keeps edits to a built-in and appends custom launchers', () => {
    const base = loadSettings(home);
    saveSettings({
      ...base,
      launchers: [
        ...base.launchers.map((l) => (l.id === 'claude'
          ? { ...l, command: 'claude --dangerously-skip-permissions --model opus', env: { ANTHROPIC_MODEL: 'opus' } }
          : l.id === 'aider' ? { ...l, enabled: false } : l)),
        { id: 'cx', label: 'cx (my Claude)', command: 'cx', env: {}, enabled: true, builtin: false },
      ],
    }, home);
    const s = loadSettings(home);
    expect(s.launchers.find((l) => l.id === 'claude')).toMatchObject({
      command: 'claude --dangerously-skip-permissions --model opus', env: { ANTHROPIC_MODEL: 'opus' }, builtin: true,
    });
    expect(s.launchers.find((l) => l.id === 'aider')?.enabled).toBe(false);
    expect(s.launchers.at(-1)).toMatchObject({ id: 'cx', label: 'cx (my Claude)', builtin: false });
  });

  // The command is typed into a shell: a line break would run a second command.
  it('refuses a bad id, a duplicate, an empty or multi-line command, and a bad env', () => {
    const base = loadSettings(home);
    const custom = (over: Record<string, unknown>) => ({ id: 'x', label: 'X', command: 'x', env: {}, enabled: true, builtin: false, ...over });
    for (const bad of [
      custom({ id: 'Bad Id' }), custom({ id: 'claude' }), custom({ id: 'terminal' }),
      custom({ command: '  ' }), custom({ command: 'a\nrm -rf x' }),
      custom({ env: { '1BAD': 'v' } }), custom({ env: { OK: 'line\nbreak' } }), custom({ label: '' }),
    ]) {
      expect(() => saveSettings({ ...base, launchers: [...base.launchers, bad as never] }, home)).toThrow(expect.objectContaining({ code: 'INVALID_SETTINGS' }));
    }
  });
});
