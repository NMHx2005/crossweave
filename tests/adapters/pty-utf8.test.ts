import { describe, expect, test } from 'bun:test';
import { spawnInPty, utf8Stream } from '../../src/adapters/pty.js';

describe('utf8Stream', () => {
  // Output arrives in chunks cut anywhere, including inside a character. Decoding each
  // chunk on its own turned the halves into U+FFFD: Claude Code's `─` rules ended in
  // "���", Vietnamese text lost letters, and every such line wrapped one cell off.
  test('a character split across chunks comes out whole', () => {
    const decode = utf8Stream();
    const bytes = new TextEncoder().encode('─ thiệp tính');
    const out = [bytes.slice(0, 1), bytes.slice(1, 2), bytes.slice(2, 9), bytes.slice(9)].map((b) => decode(b)).join('');
    expect(out).toBe('─ thiệp tính');
    expect(out).not.toContain('�');
  });

  test('strings pass through; each stream keeps its own pending bytes', () => {
    const a = utf8Stream();
    const b = utf8Stream();
    const dash = new TextEncoder().encode('─');
    expect(a(dash.slice(0, 2))).toBe('');
    expect(b('plain')).toBe('plain');
    expect(a(dash.slice(2))).toBe('─');
  });
});

describe('spawnInPty', () => {
  test('a multibyte character written in two halves reaches listeners whole', async () => {
    const proc = spawnInPty(['/bin/sh', '-c', "printf '\\342\\224'; sleep 0.2; printf '\\200 ok\\n'"], { cwd: '/tmp', env: {}, cols: 80, rows: 24 });
    let text = '';
    proc.onData((chunk) => { text += chunk; });
    await new Promise<void>((resolve) => proc.onExit(() => resolve()));
    await Bun.sleep(50);
    expect(text).toContain('─ ok');
    expect(text).not.toContain('�');
  });
});
