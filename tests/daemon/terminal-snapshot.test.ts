import { describe, expect, test } from 'bun:test';
import { prepareSnapshot, restoreScrollback, SNAPSHOT_LIMIT } from '../../src/daemon/terminal-snapshot.js';

describe('prepareSnapshot', () => {
  test('a short output is kept as it is', () => {
    expect(prepareSnapshot('hello\r\nworld\r\n')).toBe('hello\r\nworld\r\n');
  });

  test('a long one is cut to the limit and starts on a line boundary, not mid-line', () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line number ${i}`).join('\r\n');
    const out = prepareSnapshot(lines);
    expect(out.length).toBeLessThanOrEqual(SNAPSHOT_LIMIT);
    expect(out.startsWith('line number ')).toBe(true); // a whole line, not "ne number 1234"
    expect(out.endsWith('line number 4999')).toBe(true);
  });

  test('a cut that lands inside an escape sequence does not begin with its tail', () => {
    // the tail of "\x1b[38;2;10;20;30m" must not be replayed as text
    const filler = 'x'.repeat(SNAPSHOT_LIMIT - 8);
    const out = prepareSnapshot(`\x1b[38;2;10;20;30m${filler}\r\nrest\r\n`);
    expect(out).not.toMatch(/^[0-9;]+m/);
    expect(out.endsWith('rest\r\n')).toBe(true);
  });

  test('an escape sequence cut off at the END is dropped, so replay cannot swallow what follows', () => {
    expect(prepareSnapshot('done\r\n\x1b[38;2;1')).toBe('done\r\n');
    expect(prepareSnapshot('done\r\n\x1b')).toBe('done\r\n');
    expect(prepareSnapshot('done\r\n\x1b]0;title')).toBe('done\r\n'); // an OSC without its terminator
    expect(prepareSnapshot('done\x1b[0m')).toBe('done\x1b[0m'); // a complete one stays
  });

  test('never begins with half a surrogate pair', () => {
    const emoji = '😀';
    const out = prepareSnapshot(`${'a'.repeat(SNAPSHOT_LIMIT - 1)}${emoji}\r\nend`);
    expect(out.charCodeAt(0)).not.toBeGreaterThanOrEqual(0xdc00);
  });

  test('empty in, empty out', () => {
    expect(prepareSnapshot('')).toBe('');
  });
});

describe('restoreScrollback', () => {
  test('resets the terminal first, replays the snapshot, then says the shell is a new one', () => {
    const out = restoreScrollback('old output\r\n', 'A new shell — the previous one ended with the daemon');
    expect(out.startsWith('\x1bc')).toBe(true);
    expect(out).toContain('old output');
    expect(out.indexOf('old output')).toBeLessThan(out.indexOf('A new shell'));
    expect(out.trimEnd().endsWith('daemon\x1b[0m') || out.includes('A new shell')).toBe(true);
  });

  test('leaves the alternate screen and mouse/paste modes a snapshot may have ended in, and shows the cursor', () => {
    const out = restoreScrollback('vim was here\x1b[?1049h', 'note');
    for (const seq of ['\x1b[?1049l', '\x1b[?1000l', '\x1b[?1002l', '\x1b[?1006l', '\x1b[?2004l', '\x1b[?25h']) expect(out).toContain(seq);
    expect(out.indexOf('\x1b[?1049l')).toBeGreaterThan(out.indexOf('\x1b[?1049h'));
  });

  test('no snapshot: still the note, so the pane says what happened', () => {
    const out = restoreScrollback(null, 'A new shell');
    expect(out).toContain('A new shell');
    expect(out.startsWith('\x1bc')).toBe(true);
  });
});
