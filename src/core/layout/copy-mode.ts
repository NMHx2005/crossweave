/**
 * tmux's copy-mode (vi keys) as a pure state machine over a text buffer: move a cursor around
 * a pane's scrollback from the keyboard, search it, select, and yank. The pane supplies the
 * buffer and draws the result; nothing here knows about xterm or the DOM.
 *
 * Positions are (row, col) in buffer lines, a cell being one string index — wide and combining
 * characters are approximate, and `w`/`b`/`e` use a fixed notion of a word (letters, digits and
 * `_` are one kind, any other non-space run another).
 */

export interface CopyBuffer {
  lineCount: number;
  /** The text of line `i` (0 = the oldest line of scrollback); '' out of range. */
  line(i: number): string;
  /** The visible height, for the page motions. */
  rows: number;
}

export interface CopyKey {
  /** `event.key`: a character, or a name like 'Escape', 'Enter', 'Backspace'. */
  key: string;
  ctrl?: boolean;
}

interface Pos {
  row: number;
  col: number;
}

export interface CopyState {
  row: number;
  col: number;
  /** The column j/k aim for, kept across shorter lines. */
  wantCol: number;
  visual: 'char' | 'line' | null;
  anchor: Pos | null;
  /** A `g` waiting for its second `g`. */
  pending: '' | 'g';
  search: { typing: boolean; dir: 1 | -1; query: string } | null;
  lastSearch: { query: string; dir: 1 | -1 } | null;
  /** A message for the mode line ("Not found: x"). */
  notice: string | null;
}

export interface CopyResult {
  state: CopyState;
  /** Text to copy; the caller leaves copy mode too. */
  yank?: string;
  exit?: boolean;
}

function clampPos(buf: CopyBuffer, row: number, col: number): Pos {
  const r = Math.max(0, Math.min(buf.lineCount - 1, row));
  return { row: r, col: Math.max(0, Math.min(Math.max(0, buf.line(r).length - 1), col)) };
}

export function initialCopyState(buf: CopyBuffer, cursor: Pos): CopyState {
  const p = clampPos(buf, cursor.row, cursor.col);
  return { ...p, wantCol: p.col, visual: null, anchor: null, pending: '', search: null, lastSearch: null, notice: null };
}

/** 0 blank, 1 a letter/digit/underscore, 2 anything else. */
function kind(ch: string | undefined): 0 | 1 | 2 {
  if (ch === undefined || /\s/u.test(ch)) return 0;
  return /[\p{L}\p{N}_]/u.test(ch) ? 1 : 2;
}

function nextWordStart(buf: CopyBuffer, from: Pos): Pos {
  const last = buf.lineCount - 1;
  let { row, col } = from;
  let line = buf.line(row);
  const k = kind(line[col]);
  if (k !== 0) while (col < line.length && kind(line[col]) === k) col++;
  for (;;) {
    while (col < line.length && kind(line[col]) === 0) col++;
    if (col < line.length) return { row, col };
    if (row >= last) return clampPos(buf, last, Number.MAX_SAFE_INTEGER);
    row++;
    line = buf.line(row);
    col = 0;
    if (line.length === 0) return { row, col: 0 }; // an empty line is a word of its own, as in vi
  }
}

function prevWordStart(buf: CopyBuffer, from: Pos): Pos {
  let { row, col } = from;
  let line = buf.line(row);
  for (;;) {
    if (col === 0) {
      if (row === 0) return { row: 0, col: 0 };
      row--;
      line = buf.line(row);
      if (line.length === 0) return { row, col: 0 };
      col = line.length;
    }
    col--;
    if (kind(line[col]) !== 0) break;
  }
  const k = kind(line[col]);
  while (col > 0 && kind(line[col - 1]) === k) col--;
  return { row, col };
}

function wordEnd(buf: CopyBuffer, from: Pos): Pos {
  const last = buf.lineCount - 1;
  let { row, col } = from;
  let line = buf.line(row);
  col++;
  for (;;) {
    while (col < line.length && kind(line[col]) === 0) col++;
    if (col < line.length) break;
    if (row >= last) return clampPos(buf, last, Number.MAX_SAFE_INTEGER);
    row++;
    line = buf.line(row);
    col = 0;
  }
  const k = kind(line[col]);
  while (col + 1 < line.length && kind(line[col + 1]) === k) col++;
  return { row, col };
}

const isBlank = (s: string): boolean => s.trim() === '';

/** The next match of `query` from `from`, wrapping round the buffer; smart-case. */
function findMatch(buf: CopyBuffer, from: Pos, query: string, dir: 1 | -1): Pos | null {
  if (query === '' || buf.lineCount === 0) return null;
  const sensitive = query !== query.toLowerCase();
  const norm = (s: string): string => (sensitive ? s : s.toLowerCase());
  const q = norm(query);
  const n = buf.lineCount;
  for (let step = 0; step <= n; step++) {
    const row = (((from.row + dir * step) % n) + n) % n;
    const line = norm(buf.line(row));
    if (dir === 1) {
      // On the first line only what is after the cursor; on the wrap-around back to it, the rest.
      const start = step === 0 ? from.col + 1 : 0;
      const at = line.indexOf(q, start);
      if (at >= 0 && (step === 0 || step < n || at <= from.col)) return { row, col: at };
    } else {
      const end = step === 0 ? from.col - 1 : line.length;
      const at = end < 0 ? -1 : line.lastIndexOf(q, end);
      if (at >= 0 && (step === 0 || step < n || at >= from.col)) return { row, col: at };
    }
  }
  return null;
}

function selection(state: CopyState, buf: CopyBuffer): { start: Pos; end: Pos } | null {
  if (state.visual === null || state.anchor === null) return null;
  const a = state.anchor;
  const c = { row: state.row, col: state.col };
  const before = a.row < c.row || (a.row === c.row && a.col <= c.col);
  const [start, end] = before ? [a, c] : [c, a];
  if (state.visual === 'line') return { start: { row: start.row, col: 0 }, end: { row: end.row, col: Math.max(0, buf.line(end.row).length - 1) } };
  return { start, end };
}

/** The text a selection covers: characters inclusive, lines joined by newlines, trailing blanks trimmed. */
function selectedText(state: CopyState, buf: CopyBuffer): string {
  const sel = selection(state, buf);
  if (sel === null) return '';
  const out: string[] = [];
  for (let row = sel.start.row; row <= sel.end.row; row++) {
    const line = buf.line(row);
    const from = row === sel.start.row ? sel.start.col : 0;
    const to = row === sel.end.row ? sel.end.col + 1 : line.length;
    out.push(line.slice(from, to).trimEnd());
  }
  return out.join('\n');
}

/** The selection a pane should highlight, or null. */
export function copySelection(state: CopyState, buf: CopyBuffer): { start: Pos; end: Pos } | null {
  return selection(state, buf);
}

function moveTo(state: CopyState, buf: CopyBuffer, row: number, col: number, keepWant = false): CopyState {
  const p = clampPos(buf, row, col);
  return { ...state, row: p.row, col: p.col, wantCol: keepWant ? state.wantCol : p.col };
}

function vertical(state: CopyState, buf: CopyBuffer, delta: number): CopyState {
  const row = Math.max(0, Math.min(buf.lineCount - 1, state.row + delta));
  return moveTo(state, buf, row, state.wantCol, true);
}

function runSearch(state: CopyState, buf: CopyBuffer, query: string, dir: 1 | -1): CopyState {
  const hit = findMatch(buf, { row: state.row, col: state.col }, query, dir);
  const next: CopyState = { ...state, search: null, lastSearch: { query, dir } };
  if (hit === null) return { ...next, notice: `Not found: ${query}` };
  return moveTo(next, buf, hit.row, hit.col);
}

export function copyModeStep(prev: CopyState, key: CopyKey, buf: CopyBuffer): CopyResult {
  const state: CopyState = { ...prev, notice: null };
  const k = key.key;

  // Typing a search query: everything is text until Enter or Escape.
  if (state.search?.typing) {
    const s = state.search;
    if (k === 'Enter') return { state: s.query === '' ? { ...state, search: null } : runSearch(state, buf, s.query, s.dir) };
    if (k === 'Escape') return { state: { ...state, search: null } };
    if (k === 'Backspace') return { state: { ...state, search: { ...s, query: s.query.slice(0, -1) } } };
    if (!key.ctrl && [...k].length === 1) return { state: { ...state, search: { ...s, query: s.query + k } } };
    return { state };
  }

  if (key.ctrl) {
    const half = Math.max(1, Math.floor(buf.rows / 2));
    const page = Math.max(1, buf.rows);
    if (k === 'd') return { state: vertical({ ...state, pending: '' }, buf, half) };
    if (k === 'u') return { state: vertical({ ...state, pending: '' }, buf, -half) };
    if (k === 'f') return { state: vertical({ ...state, pending: '' }, buf, page) };
    if (k === 'b') return { state: vertical({ ...state, pending: '' }, buf, -page) };
    return { state: { ...state, pending: '' } };
  }

  if (state.pending === 'g') {
    const cleared: CopyState = { ...state, pending: '' };
    if (k === 'g') return { state: moveTo(cleared, buf, 0, 0) };
    return copyModeStep(cleared, key, buf); // `g` was abandoned; this key stands on its own
  }

  const line = buf.line(state.row);
  switch (k) {
    case 'h': return { state: moveTo(state, buf, state.row, state.col - 1) };
    case 'l': return { state: moveTo(state, buf, state.row, state.col + 1) };
    case 'j': return { state: vertical(state, buf, 1) };
    case 'k': return { state: vertical(state, buf, -1) };
    case '0': return { state: moveTo(state, buf, state.row, 0) };
    case '$': return { state: moveTo(state, buf, state.row, Math.max(0, line.length - 1)) };
    case 'w': { const p = nextWordStart(buf, state); return { state: moveTo(state, buf, p.row, p.col) }; }
    case 'b': { const p = prevWordStart(buf, state); return { state: moveTo(state, buf, p.row, p.col) }; }
    case 'e': { const p = wordEnd(buf, state); return { state: moveTo(state, buf, p.row, p.col) }; }
    case 'G': return { state: moveTo(state, buf, buf.lineCount - 1, 0) };
    case 'g': return { state: { ...state, pending: 'g' } };
    case '}': {
      let r = state.row + 1;
      while (r < buf.lineCount - 1 && !isBlank(buf.line(r))) r++;
      return { state: moveTo(state, buf, Math.min(r, buf.lineCount - 1), 0) };
    }
    case '{': {
      let r = state.row - 1;
      while (r > 0 && !isBlank(buf.line(r))) r--;
      return { state: moveTo(state, buf, Math.max(r, 0), 0) };
    }
    case '/': return { state: { ...state, search: { typing: true, dir: 1, query: '' } } };
    case '?': return { state: { ...state, search: { typing: true, dir: -1, query: '' } } };
    case 'n':
    case 'N': {
      const last = state.lastSearch;
      if (last === null) return { state };
      const dir = (k === 'n' ? last.dir : -last.dir) as 1 | -1;
      return { state: runSearch(state, buf, last.query, dir) };
    }
    case 'v':
      return { state: state.visual === 'char' ? { ...state, visual: null, anchor: null } : { ...state, visual: 'char', anchor: state.anchor ?? { row: state.row, col: state.col } } };
    case 'V':
      return { state: state.visual === 'line' ? { ...state, visual: null, anchor: null } : { ...state, visual: 'line', anchor: state.anchor ?? { row: state.row, col: state.col } } };
    case 'y': {
      if (state.visual === null) return { state };
      return { state, yank: selectedText(state, buf), exit: true };
    }
    case 'Y': return { state, yank: line.trimEnd(), exit: true };
    case 'q': return { state, exit: true };
    case 'Escape':
      return state.visual !== null ? { state: { ...state, visual: null, anchor: null } } : { state, exit: true };
    default:
      return { state };
  }
}
