import { describe, expect, test } from 'bun:test';
import { copyModeStep, initialCopyState, type CopyBuffer, type CopyKey, type CopyState } from '../../src/core/layout/copy-mode.js';

const buf = (lines: string[], rows = 4): CopyBuffer => ({ lineCount: lines.length, line: (i) => lines[i] ?? '', rows });

/** Feed keys ('Ctrl-u' style for control, plain characters otherwise) and return the last result. */
function run(lines: string[], keys: string[], opts: { at?: { row: number; col: number }; rows?: number } = {}): { state: CopyState; yank?: string; exited: boolean } {
  const b = buf(lines, opts.rows ?? 4);
  let state = initialCopyState(b, opts.at ?? { row: 0, col: 0 });
  let yank: string | undefined;
  let exited = false;
  for (const k of keys) {
    const key: CopyKey = k.startsWith('Ctrl-') ? { key: k.slice(5), ctrl: true } : { key: k };
    const r = copyModeStep(state, key, b);
    state = r.state;
    if (r.yank !== undefined) yank = r.yank;
    if (r.exit) exited = true;
  }
  return { state, ...(yank === undefined ? {} : { yank }), exited };
}
const at = (r: { state: CopyState }): [number, number] => [r.state.row, r.state.col];
const TEXT = ['hello world foo', 'second line', '', 'fourth line here', 'last'];

describe('motions', () => {
  test('h j k l move one cell, clamped to the text', () => {
    expect(at(run(TEXT, ['l', 'l', 'j']))).toEqual([1, 2]);
    expect(at(run(TEXT, ['h', 'k']))).toEqual([0, 0]);
    expect(at(run(TEXT, ['j', 'j', 'j', 'j', 'j', 'j']))).toEqual([4, 0]); // the last line is a stop
  });

  test('j and k remember the column you wanted across shorter lines', () => {
    // col 8 on line 0, down onto the empty line 2 and back to a long line: back at col 8
    expect(at(run(TEXT, ['l', 'l', 'l', 'l', 'l', 'l', 'l', 'l', 'j', 'j', 'j']))).toEqual([3, 8]);
  });

  test('0 and $ go to the start and the last character of the line', () => {
    expect(at(run(TEXT, ['$']))).toEqual([0, 14]);
    expect(at(run(TEXT, ['$', '0']))).toEqual([0, 0]);
    expect(at(run(TEXT, ['j', 'j', '$']))).toEqual([2, 0]); // an empty line has no last character
  });

  test('w moves to the next word start, across punctuation and onto the next line', () => {
    expect(at(run(TEXT, ['w']))).toEqual([0, 6]);
    expect(at(run(TEXT, ['w', 'w']))).toEqual([0, 12]);
    expect(at(run(TEXT, ['w', 'w', 'w']))).toEqual([1, 0]);
    expect(at(run(['a.b c'], ['w']))).toEqual([0, 1]); // punctuation is its own word
  });

  test('b moves back to the previous word start; e to the end of the word', () => {
    expect(at(run(TEXT, ['w', 'w', 'b']))).toEqual([0, 6]);
    expect(at(run(TEXT, ['e']))).toEqual([0, 4]);
    expect(at(run(TEXT, ['e', 'e']))).toEqual([0, 10]);
  });

  test('gg and G go to the first and last line', () => {
    expect(at(run(TEXT, ['G']))).toEqual([4, 0]);
    expect(at(run(TEXT, ['G', 'g', 'g']))).toEqual([0, 0]);
  });

  test('a lone g does nothing; g then something else is not a motion', () => {
    expect(at(run(TEXT, ['j', 'g', 'l']))).toEqual([1, 1]); // g cancelled, then l moved
  });

  test('{ and } jump to the previous / next blank line', () => {
    expect(at(run(TEXT, ['}']))).toEqual([2, 0]);
    expect(at(run(TEXT, ['G', '{']))).toEqual([2, 0]);
  });

  test('Ctrl-d / Ctrl-u move half a screen, Ctrl-f / Ctrl-b a whole one', () => {
    const many = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    expect(at(run(many, ['Ctrl-d'], { rows: 10 }))[0]).toBe(5);
    expect(at(run(many, ['Ctrl-f'], { rows: 10 }))[0]).toBe(10);
    expect(at(run(many, ['Ctrl-f', 'Ctrl-f', 'Ctrl-b'], { rows: 10 }))[0]).toBe(10);
    expect(at(run(many, ['Ctrl-d', 'Ctrl-u'], { rows: 10 }))[0]).toBe(0);
    expect(at(run(many, ['Ctrl-u'], { rows: 10 }))[0]).toBe(0); // clamped at the top
  });
});

describe('search', () => {
  const lines = ['alpha beta', 'gamma Beta', 'delta', 'beta again'];

  test('/ then a query and Enter jumps to the next match after the cursor', () => {
    expect(at(run(lines, ['/', 'g', 'a', 'Enter']))).toEqual([1, 0]);
  });

  test('a lower-case query ignores case; one with a capital does not', () => {
    expect(at(run(lines, ['/', 'b', 'e', 't', 'a', 'Enter']))).toEqual([0, 6]);
    expect(at(run(lines, ['/', 'B', 'e', 't', 'a', 'Enter']))).toEqual([1, 6]);
  });

  test('n repeats forward, N backward, and the search wraps around', () => {
    const first = run(lines, ['/', 'b', 'e', 't', 'a', 'Enter']);
    expect(at(first)).toEqual([0, 6]);
    expect(at(run(lines, ['/', 'b', 'e', 't', 'a', 'Enter', 'n']))).toEqual([1, 6]);
    expect(at(run(lines, ['/', 'b', 'e', 't', 'a', 'Enter', 'n', 'n', 'n']))).toEqual([0, 6]); // wrapped
    expect(at(run(lines, ['/', 'b', 'e', 't', 'a', 'Enter', 'N']))).toEqual([3, 0]); // wrapped backward
  });

  test('? searches backward from the cursor', () => {
    expect(at(run(lines, ['G', '?', 'a', 'l', 'p', 'Enter']))).toEqual([0, 0]);
  });

  test('Backspace edits the query, Escape abandons the search and stays where it was', () => {
    expect(at(run(lines, ['/', 'x', 'Backspace', 'g', 'a', 'Enter']))).toEqual([1, 0]);
    const r = run(lines, ['j', '/', 'z', 'Escape']);
    expect(at(r)).toEqual([1, 0]);
    expect(r.state.search).toBeNull();
    expect(r.exited).toBe(false);
  });

  test('no match: the cursor stays and the state says so', () => {
    const r = run(lines, ['/', 'q', 'q', 'q', 'Enter']);
    expect(at(r)).toEqual([0, 0]);
    expect(r.state.notice).toMatch(/not found/i);
  });

  test('while typing a query, motion keys are text, not motions', () => {
    const r = run(lines, ['/', 'j', 'k']);
    expect(r.state.search?.query).toBe('jk');
    expect(at(r)).toEqual([0, 0]);
  });
});

describe('visual selection and yank', () => {
  test('v then motions then y yanks from the anchor to the cursor, inclusive, and leaves copy mode', () => {
    const r = run(TEXT, ['v', 'e', 'y']);
    expect(r.yank).toBe('hello');
    expect(r.exited).toBe(true);
  });

  test('a selection made backwards yanks the same text', () => {
    const r = run(TEXT, ['e', 'v', '0', 'y']);
    expect(r.yank).toBe('hello');
  });

  test('a selection across lines joins them with newlines, trailing spaces trimmed', () => {
    const r = run(['abc   ', 'def', 'ghi'], ['l', 'v', 'j', 'l', 'y']);
    expect(r.yank).toBe('bc\ndef');
  });

  test('V selects whole lines, whatever the column', () => {
    const r = run(TEXT, ['l', 'l', 'V', 'j', 'y']);
    expect(r.yank).toBe('hello world foo\nsecond line');
  });

  test('Y yanks the current line without a selection', () => {
    expect(run(TEXT, ['j', 'Y']).yank).toBe('second line');
  });

  test('y without a selection yanks nothing and stays in copy mode', () => {
    const r = run(TEXT, ['y']);
    expect(r.yank).toBeUndefined();
    expect(r.exited).toBe(false);
  });

  test('v again drops the selection; Escape clears a selection before it leaves', () => {
    expect(run(TEXT, ['v', 'v']).state.visual).toBeNull();
    const cleared = run(TEXT, ['v', 'Escape']);
    expect(cleared.state.visual).toBeNull();
    expect(cleared.exited).toBe(false);
    expect(run(TEXT, ['v', 'Escape', 'Escape']).exited).toBe(true);
  });
});

describe('leaving', () => {
  test('q leaves at once, from anywhere', () => {
    expect(run(TEXT, ['q']).exited).toBe(true);
    expect(run(TEXT, ['v', 'j', 'q']).exited).toBe(true);
  });

  test('Escape leaves when nothing is selected or being typed', () => {
    expect(run(TEXT, ['Escape']).exited).toBe(true);
  });
});

describe('robustness', () => {
  test('an empty buffer never throws, and every motion stays at 0,0', () => {
    for (const k of ['h', 'j', 'k', 'l', 'w', 'b', 'e', '$', '0', 'G', '{', '}', 'Ctrl-d', 'Ctrl-u']) {
      const r = run([''], [k]);
      expect(at(r)).toEqual([0, 0]);
    }
  });

  test('an unknown key changes nothing', () => {
    const r = run(TEXT, ['j', '@', 'F1', 'Shift']);
    expect(at(r)).toEqual([1, 0]);
    expect(r.exited).toBe(false);
  });

  test('wide and combining characters are treated as one cell per string index (approximate, documented)', () => {
    expect(at(run(['日本語 text'], ['w']))).toEqual([0, 4]);
  });

  test('starting inside the buffer clamps a cursor that is outside it', () => {
    const r = run(['abc'], [], { at: { row: 99, col: 99 } });
    expect(at(r)).toEqual([0, 2]);
  });
});
