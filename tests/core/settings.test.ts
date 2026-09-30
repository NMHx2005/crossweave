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

describe('terminal appearance', () => {
  const ansi = Array.from({ length: 16 }, (_, i) => `#${i.toString(16).padStart(2, '0').repeat(3)}`);
  const imported = {
    fontFamily: 'JetBrainsMono Nerd Font Mono',
    fontSize: 12,
    cursorStyle: 'bar' as const,
    cursorBlink: false,
    optionAsMeta: true,
    colors: { background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', cursorText: '#1e1e2e', selection: '#585b70', ansi },
    importedFrom: 'ghostty' as const,
  };

  it('is absent by default: panes keep the cockpit palette', () => {
    expect(loadSettings(home).terminal).toBeUndefined();
  });

  it('round-trips through save and load', () => {
    saveSettings({ ...loadSettings(home), terminal: imported }, home);
    expect(loadSettings(home).terminal).toEqual(imported);
  });

  // The family reaches xterm's font string: nothing that could close the quotes or
  // start another declaration.
  it('refuses what is not a font family, size, color or palette', () => {
    const base = loadSettings(home);
    for (const bad of [
      { fontFamily: 'Menlo"; x: y' },
      { fontFamily: '' },
      { fontSize: 7 },
      { fontSize: 12.5 },
      { cursorStyle: 'beam' },
      { colors: { ...imported.colors, background: 'red' } },
      { colors: { ...imported.colors, ansi: ansi.slice(0, 8) } },
      { importedFrom: 'kitty' },
    ]) {
      expect(() => saveSettings({ ...base, terminal: { ...imported, ...bad } as never }, home)).toThrow(/terminal/i);
    }
  });

  it('a bad saved value is dropped on load, not fatal', () => {
    mkdirSync(join(home, '.crossweave'), { recursive: true });
    writeFileSync(file(), JSON.stringify({ terminal: { fontFamily: 'Menlo"; x', fontSize: 14, colors: { background: 'nope' } } }));
    expect(loadSettings(home).terminal).toEqual({ fontSize: 14 });
  });
});

describe('interface appearance', () => {
  it('is absent by default: the cockpit fonts and sizes', () => {
    expect(loadSettings(home).appearance).toBeUndefined();
  });

  it('round-trips an interface font, a code font and a text size', () => {
    const appearance = { uiFont: 'Inter', codeFont: 'JetBrains Mono', textSize: 'large' as const, theme: 'light' as const };
    saveSettings({ ...loadSettings(home), appearance }, home);
    expect(loadSettings(home).appearance).toEqual(appearance);
  });

  // The family becomes a CSS custom property value on the whole window.
  it('refuses what is not a font family or a known size', () => {
    const base = loadSettings(home);
    for (const bad of [{ uiFont: 'Inter; color: red' }, { codeFont: 'x"' }, { textSize: 'huge' }, { theme: 'neon' }]) {
      expect(() => saveSettings({ ...base, appearance: bad as never }, home)).toThrow(/appearance/i);
    }
  });

  it('a bad saved value is dropped on load', () => {
    mkdirSync(join(home, '.crossweave'), { recursive: true });
    writeFileSync(file(), JSON.stringify({ appearance: { uiFont: 'Inter; x', textSize: 'small' } }));
    expect(loadSettings(home).appearance).toEqual({ textSize: 'small' });
  });
});

describe('usage settings', () => {
  it('round-trips the rail toggle and per-model prices (USD per million tokens)', () => {
    const usage = { show: true, prices: { 'claude-opus-5-5': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 } } };
    saveSettings({ ...loadSettings(home), usage }, home);
    expect(loadSettings(home).usage).toEqual(usage);
  });

  it('refuses a model name or price that cannot be one', () => {
    const base = loadSettings(home);
    for (const bad of [
      { prices: { 'a b"': { input: 1, output: 1, cacheWrite: 1, cacheRead: 1 } } },
      { prices: { m: { input: -1, output: 1, cacheWrite: 1, cacheRead: 1 } } },
      { prices: { m: { input: 1, output: 'x', cacheWrite: 1, cacheRead: 1 } } },
      { show: 'yes' },
    ]) {
      expect(() => saveSettings({ ...base, usage: bad as never }, home)).toThrow(/usage/i);
    }
  });
});

describe('keybindings', () => {
  it('round-trips overrides; null unbinds a command', () => {
    const keybindings = { 'command-bar': 'CmdOrCtrl+Shift+P', find: null };
    saveSettings({ ...loadSettings(home), keybindings }, home);
    expect(loadSettings(home).keybindings).toEqual(keybindings);
  });

  it('refuses what cannot be a command id or an accelerator', () => {
    const base = loadSettings(home);
    for (const bad of [{ 'Bad Id': 'CmdOrCtrl+K' }, { find: 'Cmd+K; rm' }, { find: 12 }]) {
      expect(() => saveSettings({ ...base, keybindings: bad as never }, home)).toThrow(/keybinding/i);
    }
  });
});

describe('a settings file from a version that had voice input', () => {
  it('still loads: the retired voice block is ignored, and the next save drops it', () => {
    mkdirSync(join(home, '.crossweave'), { recursive: true });
    writeFileSync(file(), JSON.stringify({ editor: { kind: 'zed' }, voice: { transcribeCommand: 'whisper-cli -f {audio}', language: 'vi' } }));
    const s = loadSettings(home);
    expect(s.editor).toEqual({ kind: 'zed' });
    expect('voice' in s).toBe(false);
    saveSettings(s, home);
    expect(readFileSync(file(), 'utf8')).not.toContain('voice');
  });

  it('keeps the file readable by the user only', () => {
    saveSettings({ ...loadSettings(home), editor: { kind: 'zed' } }, home);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
  });
});

describe('prompt settings (the composer\'s refine command)', () => {
  const valid = { refine: { command: 'claude -p', instruction: 'Restructure; add nothing.', includeContext: true } };

  it('round-trips through save and load, and is absent by default', () => {
    expect(loadSettings(home).prompt).toBeUndefined();
    saveSettings({ ...loadSettings(home), prompt: valid }, home);
    expect(loadSettings(home).prompt).toEqual(valid);
  });

  it('refuses a command that spans lines, is unbalanced, or is too long', () => {
    for (const command of ['claude -p\nrm -rf ~', 'claude "unbalanced', 'x'.repeat(2001)]) {
      expect(() => saveSettings({ ...loadSettings(home), prompt: { refine: { command } } }, home)).toThrow(/prompt/i);
    }
  });

  it('refuses an instruction that is not text, is over 4000 characters or has a NUL, and a flag that is not a boolean', () => {
    expect(() => saveSettings({ ...loadSettings(home), prompt: { refine: { instruction: 'x'.repeat(4001) } } }, home)).toThrow(/instruction/i);
    expect(() => saveSettings({ ...loadSettings(home), prompt: { refine: { instruction: 'a\0b' } } }, home)).toThrow(/instruction/i);
    expect(() => saveSettings({ ...loadSettings(home), prompt: { refine: { includeContext: 'yes' as never } } }, home)).toThrow(/prompt/i);
  });

  it('a corrupt prompt block in the file is dropped on load rather than breaking other settings', () => {
    mkdirSync(join(home, '.crossweave'), { recursive: true });
    writeFileSync(file(), JSON.stringify({ editor: { kind: 'zed' }, prompt: { refine: { command: 'a\nb', includeContext: 3 } } }));
    const s = loadSettings(home);
    expect(s.editor).toEqual({ kind: 'zed' });
    expect(s.prompt).toBeUndefined();
  });

  it('an empty block or a blank command is not kept', () => {
    saveSettings({ ...loadSettings(home), prompt: { refine: { command: '   ' } } }, home);
    expect(loadSettings(home).prompt).toBeUndefined();
  });
});

describe('session presets', () => {
  const dev = { name: 'web dev', launcher: 'claude', worktree: true, terminals: ['bun dev', 'bun test --watch'], browser: { path: '/admin' } };

  it('round-trips through save and load, and is absent by default', () => {
    expect(loadSettings(home).presets).toBeUndefined();
    saveSettings({ ...loadSettings(home), presets: [dev] }, home);
    expect(loadSettings(home).presets).toEqual([dev]);
  });

  it('a name alone is a valid preset (a plain terminal in its own worktree)', () => {
    saveSettings({ ...loadSettings(home), presets: [{ name: 'scratch' }] }, home);
    expect(loadSettings(home).presets).toEqual([{ name: 'scratch' }]);
  });

  it('refuses a bad name: empty, multi-line, too long, or a duplicate', () => {
    for (const name of ['', '   ', 'a\nb', 'x'.repeat(41)]) {
      expect(() => saveSettings({ ...loadSettings(home), presets: [{ name }] }, home)).toThrow(/preset/i);
    }
    expect(() => saveSettings({ ...loadSettings(home), presets: [{ name: 'a' }, { name: 'a' }] }, home)).toThrow(/preset/i);
  });

  it('refuses more than 12 presets, more than 4 terminals, and terminal commands that are not one plain line', () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ name: `p${i}` }));
    expect(() => saveSettings({ ...loadSettings(home), presets: many }, home)).toThrow(/preset/i);
    expect(() => saveSettings({ ...loadSettings(home), presets: [{ name: 'a', terminals: ['1', '2', '3', '4', '5'] }] }, home)).toThrow(/terminal/i);
    for (const bad of ['', 'a\nb', 'x'.repeat(501), 'a\0b', 'a\u001b[31m']) {
      expect(() => saveSettings({ ...loadSettings(home), presets: [{ name: 'a', terminals: [bad] }] }, home)).toThrow(/terminal/i);
    }
  });

  it('refuses a launcher id that is not a plain id, and a browser path that is not a path', () => {
    for (const launcher of ['', 'a b', 'x'.repeat(41), '../x', 'A;B']) {
      expect(() => saveSettings({ ...loadSettings(home), presets: [{ name: 'a', launcher }] }, home)).toThrow(/launcher/i);
    }
    for (const path of ['admin', '/a b', '/x'.repeat(101), '/a\n', 'http://evil.example/']) {
      expect(() => saveSettings({ ...loadSettings(home), presets: [{ name: 'a', browser: { path } }] }, home)).toThrow(/browser/i);
    }
  });

  it('a corrupt presets block in the file is dropped on load rather than breaking other settings', () => {
    mkdirSync(join(home, '.crossweave'), { recursive: true });
    writeFileSync(file(), JSON.stringify({ editor: { kind: 'zed' }, presets: 'nope' }));
    const s = loadSettings(home);
    expect(s.editor).toEqual({ kind: 'zed' });
    expect(s.presets).toBeUndefined();
  });
});

describe('key-table bindings in the keybindings', () => {
  it('accepts prefix:<key> for a character or a named key, and stores it as given', () => {
    saveSettings({ ...loadSettings(home), keybindings: { 'split-right': 'prefix:|', 'focus-left': 'prefix:Left', 'zoom-pane': 'prefix:%', 'x': 'prefix:đ' } }, home);
    expect(loadSettings(home).keybindings).toMatchObject({ 'split-right': 'prefix:|', 'focus-left': 'prefix:Left', 'zoom-pane': 'prefix:%' });
  });

  it('refuses a malformed one: empty, several characters, whitespace, or a control character', () => {
    for (const bad of ['prefix:', 'prefix:ab', 'prefix: ', 'prefix:\n', 'prefix:Home']) {
      expect(() => saveSettings({ ...loadSettings(home), keybindings: { 'split-right': bad } }, home)).toThrow();
    }
  });
});

describe('persistence settings', () => {
  it('is off by default: nothing is stored until it is switched on', () => {
    expect(loadSettings(home).persistence).toBeUndefined();
    expect(loadSettings(home).persistence?.terminals).toBeUndefined();
  });

  it('round-trips the switch', () => {
    saveSettings({ ...loadSettings(home), persistence: { terminals: true } }, home);
    expect(loadSettings(home).persistence).toEqual({ terminals: true });
  });

  it('refuses a value that is not a boolean, and drops a corrupt block on load', () => {
    expect(() => saveSettings({ ...loadSettings(home), persistence: { terminals: 'yes' as never } }, home)).toThrow(/persistence/i);
    mkdirSync(join(home, '.crossweave'), { recursive: true });
    writeFileSync(file(), JSON.stringify({ editor: { kind: 'zed' }, persistence: { terminals: 'yes' } }));
    expect(loadSettings(home).persistence).toBeUndefined();
    expect(loadSettings(home).editor).toEqual({ kind: 'zed' });
  });
});
