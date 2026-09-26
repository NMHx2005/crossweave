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
    expect(loadSettings(home)).toEqual({ editor: { kind: 'vscode' }, layouts: {} });
  });

  it('reads a saved editor and layouts', () => {
    saveSettings({ editor: { kind: 'zed' }, layouts: { review: { tabs: [] } } }, home);
    expect(loadSettings(home)).toEqual({ editor: { kind: 'zed' }, layouts: { review: { tabs: [] } } });
  });

  // crossweave no longer launches agents; an older file's agent list must not break
  // loading, and is dropped on the next save.
  it('ignores an agents list left by an older version', () => {
    mkdirSync(join(home, '.crossweave'), { recursive: true });
    writeFileSync(file(), JSON.stringify({ agents: [{ id: 'claude', command: 'claude' }], editor: { kind: 'cursor' } }));
    const s = loadSettings(home);
    expect(s).toEqual({ editor: { kind: 'cursor' }, layouts: {} });
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
    expect(() => saveSettings({ editor: { kind: 'emacs' as never }, layouts: {} }, home)).toThrow(/editor/i);
    expect(() => saveSettings({ editor: { kind: 'custom' }, layouts: {} }, home)).toThrow(/editor/i);
    expect(() => saveSettings({ editor: { kind: 'custom', command: 'subl "{file}' }, layouts: {} }, home)).toThrow(/quote/i);
  });

  it('writes a file only the user can read', () => {
    saveSettings(loadSettings(home), home);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
  });
});
