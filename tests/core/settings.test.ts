import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_AGENTS, loadSettings, saveSettings, splitCommand } from '../../src/core/settings.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cw-settings-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('splitCommand', () => {
  // The daemon runs these as argv, never through a shell: quoting is honoured, but
  // `;`, `$(…)` and friends are just characters in an argument.
  it('splits on whitespace and honours quotes and escapes', () => {
    expect(splitCommand('codex -c tui.animations=false')).toEqual(['codex', '-c', 'tui.animations=false']);
    expect(splitCommand(`agent --msg "hello world" --x 'a b' c\\ d`)).toEqual(['agent', '--msg', 'hello world', '--x', 'a b', 'c d']);
    expect(splitCommand('echo $(whoami); rm x')).toEqual(['echo', '$(whoami);', 'rm', 'x']);
  });

  it('rejects an empty command and unbalanced quotes', () => {
    expect(() => splitCommand('   ')).toThrow(/empty/i);
    expect(() => splitCommand('agent "open')).toThrow(/quote/i);
  });
});

describe('loadSettings', () => {
  it('lists the built-in agents, enabled, when nothing is saved', () => {
    const s = loadSettings(home);
    expect(s.agents.map((a) => a.id)).toEqual(BUILTIN_AGENTS.map((a) => a.id));
    expect(s.agents.map((a) => a.id)).toEqual(['claude', 'codex', 'opencode', 'gemini', 'antigravity']);
    expect(s.agents.every((a) => a.enabled && a.builtin)).toBe(true);
    // Normal, asking mode: no bypass flags unless the user adds them.
    expect(s.agents.find((a) => a.id === 'codex')?.command).toBe('codex');
    expect(s.editor).toEqual({ kind: 'vscode' });
  });

  it('applies saved overrides to built-ins and appends custom agents', () => {
    saveSettings({
      agents: [
        { id: 'codex', label: 'Codex', command: 'codex --full-auto', enabled: false, builtin: true },
        { id: 'my-agent', label: 'Mine', command: 'my-agent --flag', enabled: true, builtin: false },
      ],
      editor: { kind: 'zed' },
      layouts: {},
    }, home);
    const s = loadSettings(home);
    const codex = s.agents.find((a) => a.id === 'codex')!;
    expect(codex).toMatchObject({ command: 'codex --full-auto', enabled: false, builtin: true });
    expect(s.agents.find((a) => a.id === 'claude')?.enabled).toBe(true);
    expect(s.agents.at(-1)).toMatchObject({ id: 'my-agent', builtin: false });
    expect(s.editor.kind).toBe('zed');
  });

  it('falls back to defaults for a corrupt file rather than breaking every command', () => {
    mkdirSync(join(home, '.crossweave'), { recursive: true });
    writeFileSync(join(home, '.crossweave', 'settings.json'), '{not json');
    expect(loadSettings(home).agents.length).toBe(BUILTIN_AGENTS.length);
  });
});

describe('saveSettings', () => {
  it('refuses a bad agent id, a duplicate id, an unparseable command, a bad editor', () => {
    const base = loadSettings(home);
    const custom = (id: string, command = 'x') => ({ id, label: id, command, enabled: true, builtin: false });
    expect(() => saveSettings({ ...base, agents: [...base.agents, custom('Bad Id')] }, home)).toThrow(/agent id/i);
    expect(() => saveSettings({ ...base, agents: [...base.agents, custom('codex')] }, home)).toThrow(/duplicate/i);
    expect(() => saveSettings({ ...base, agents: [...base.agents, custom('ok', 'x "')] }, home)).toThrow(/quote/i);
    expect(() => saveSettings({ ...base, editor: { kind: 'emacs' as never } }, home)).toThrow(/editor/i);
    expect(() => saveSettings({ ...base, editor: { kind: 'custom' } }, home)).toThrow(/editor/i);
  });

  it('writes a file only the user can read', () => {
    saveSettings(loadSettings(home), home);
    expect(statSync(join(home, '.crossweave', 'settings.json')).mode & 0o777).toBe(0o600);
  });
});
