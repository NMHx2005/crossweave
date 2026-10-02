import { describe, it, expect } from 'bun:test';
import { ErrorLines, errorLineOf, normalizeErrorKey, stripAnsi } from '../../src/daemon/error-lines.js';

/**
 * Build/test error lines found in a session's terminal stream — the heuristic the
 * debug bundle shows (labelled as one everywhere). Bounded per session (a ring of
 * lines/bytes), deduped by a normalised key, RAM only: this is debug state, not
 * history.
 */

const CLOCK = { now: () => 42 };

describe('errorLineOf (heuristic, applied to ONE line)', () => {
  it('catches the common failure shapes', () => {
    for (const line of [
      'src/index.ts:42:10 - error TS2345: Argument of type...',
      'src/main.c:7:3: error: expected ";" before',
      'Traceback (most recent call last):',
      'ERROR in ./src/app.ts',
      '✗ 3 tests failed',
      '✖ expected 2 to be 3',
      'FAIL  tests/app.test.ts',
      'npm ERR! code ELIFECYCLE',
      'error: build failed',
    ]) {
      expect(errorLineOf(line)).toBe(true);
    }
  });

  it('leaves ordinary output alone', () => {
    for (const line of [
      '✓ 12 tests passed',
      'building for production…',
      'warn: deprecated call in src/old.ts',
      'errorless output with the word error inside: noErrorMatches',
      'no error: none here', // "error:" not first on the line is speech, not a report
    ]) {
      expect(errorLineOf(line)).toBe(false);
    }
  });
});

describe('stripAnsi + normalizeErrorKey (dedupe key)', () => {
  it('strips colour and cursor codes before matching', () => {
    expect(stripAnsi('\x1b[31m\x1b[1mERROR\x1b[0m in ./src/app.ts')).toBe('ERROR in ./src/app.ts');
    expect(errorLineOf(stripAnsi('\x1b[31mERROR\x1b[0m: build failed'))).toBe(true);
  });

  it('the key normalises digits and timing so one error repeated is one entry', () => {
    expect(normalizeErrorKey('error TS2345: got 12, expected 3 (12ms)'))
      .toBe(normalizeErrorKey('error TS2345: got 99, expected 4 (987ms)'));
    expect(normalizeErrorKey('error TS2345: type mismatch'))
      .not.toBe(normalizeErrorKey('error TS2322: type mismatch'));
  });
});

describe('ErrorLines (bounded ring per session)', () => {
  it('keeps newest errors, dedupes repeats, and holds the budget', () => {
    const e = new ErrorLines({ now: CLOCK.now });
    e.observe('s', 'first error TS2345: something (12ms)\r\n');
    e.observe('s', '\x1b[31msecond\x1b[0m ERROR in app\r\n');
    e.observe('s', 'first error TS2345: something (98ms)\r\n'); // same key: digits collapsed, code kept
    e.observe('s', '✓ 12 tests passed\r\n'); // not an error: dropped
    expect(e.lines('s').map((l) => l.line)).toEqual([
      'first error TS2345: something (12ms)',
      'second ERROR in app',
    ]);
  });

  it('evicts oldest past the line and byte budget', () => {
    const e = new ErrorLines({ now: CLOCK.now, maxLines: 3, maxBytes: 400 });
    for (let i = 0; i < 5; i++) e.observe('s', `error TS234${i}: very long line of diagnostic text ${i}\r\n`);
    const lines = e.lines('s');
    expect(lines).toHaveLength(3);
    expect(lines[0]?.line).toContain('error TS2342');
    expect(lines[2]?.line).toContain('error TS2344');
    // Byte budget respected overall (the newest are kept, not the quota of 400 bytes of the newest).
    expect(lines.every((l) => l.line.length > 0)).toBe(true);
  });

  it('sessions are separate, and a forgotten session is gone', () => {
    const e = new ErrorLines({ now: CLOCK.now });
    e.observe('a', 'ERROR one\r\n');
    e.observe('b', 'ERROR two\r\n');
    expect(e.lines('a').map((l) => l.line)).toEqual(['ERROR one']);
    e.forget('a');
    expect(e.lines('a')).toEqual([]);
    expect(e.lines('b').map((l) => l.line)).toEqual(['ERROR two']);
  });

  it('a chunk without a newline keeps buffering, then flushes on the newline', () => {
    const e = new ErrorLines({ now: CLOCK.now });
    e.observe('s', 'ERROR bu');
    expect(e.lines('s')).toEqual([]);
    e.observe('s', 'ild failed\r\n');
    expect(e.lines('s').map((l) => l.line)).toEqual(['ERROR build failed']);
  });

  it('a lone \\r ends a line too: a progress bar redraws are judged, not accumulated', () => {
    const e = new ErrorLines({ now: CLOCK.now });
    e.observe('s', 'ERROR build failed\rprogress 1%\rprogress 2%\r');
    expect(e.lines('s').map((l) => l.line)).toEqual(['ERROR build failed']);
    // The pending buffer did not eat the redraws.
    e.observe('s', 'error TS2322: boom\r\n');
    expect(e.lines('s').map((l) => l.line)).toEqual(['ERROR build failed', 'error TS2322: boom']);
  });

  it('a terminator-less giant chunk is capped to its tail, not grown for the daemon\'s life', () => {
    const e = new ErrorLines({ now: CLOCK.now, pendingCap: 32 });
    // The error words sit at the end: what the cap keeps (the tail) still carries them.
    e.observe('s', 'x'.repeat(400) + ' error TS2322: boom');
    // A second giant chunk cannot stack onto the first one's buffer.
    e.observe('s', 'y'.repeat(400) + ' error TS2304: bang');
    const seen = e.lines('s').map((l) => l.line);
    expect(seen).toHaveLength(2);
    // Each kept exactly its capped tail, which still carried the error words.
    expect(seen[0]).toContain('error TS2322: boom');
    expect(seen[0]!.length).toBeLessThanOrEqual(32);
    expect(seen[1]).toContain('error TS2304: bang');
  });
});
