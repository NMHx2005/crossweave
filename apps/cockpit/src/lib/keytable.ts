import { keyMatchesAccelerator } from './keymap'

/**
 * tmux's prefix key, owned: press the prefix chord, then one key, and that key runs a command.
 * Pure — the window's key listener feeds it presses and acts on what it answers.
 *
 * It is dangerous by nature: Ctrl-a is beginning-of-line in a shell. So it acts only while a
 * terminal pane has the keyboard (`isTerminalFocus`), never in an input; pressing the prefix
 * twice sends the literal Ctrl-a; and the prefix can be rebound or unbound (no prefix, no
 * interception at all).
 */

export const DEFAULT_PREFIX = 'Ctrl+A'

/** How long prefix mode waits for the next key before it lapses. */
export const PREFIX_TIMEOUT_MS = 3000

/**
 * tmux's default bindings, by `event.key` (so punctuation works on any layout and case
 * matters), mapped to command ids from keymap.ts.
 */
export const DEFAULT_TABLE: Readonly<Record<string, string>> = {
  '%': 'split-right',
  '"': 'split-down',
  z: 'zoom-pane',
  Left: 'focus-left',
  Right: 'focus-right',
  Up: 'focus-up',
  Down: 'focus-down',
  o: 'swap-next',
  x: 'close-pane',
  '[': 'copy-mode',
  c: 'new-agent',
  n: 'next-tab',
  p: 'prev-tab',
  Space: 'cycle-layout',
  ':': 'command-bar',
  '?': 'show-shortcuts',
  '!': 'pane-to-tab',
  s: 'sync-panes',
}

/** A key press, as the window's listener reports it. */
export interface Press {
  key: string
  code: string
  ctrl: boolean
  meta: boolean
  alt: boolean
  shift: boolean
  isComposing: boolean
}

export interface KeyTableState {
  mode: 'root' | 'prefix'
  /** When prefix mode began, for the timeout. */
  since: number
}

export interface KeyTableConfig {
  /** The prefix chord (an Electron accelerator), or null: no key-table. */
  prefix: string | null
  table: Readonly<Record<string, string>>
}

export type KeyTableAction =
  | { type: 'pass' }
  | { type: 'swallow' }
  | { type: 'literal' }
  | { type: 'command'; id: string }

export interface KeyTableOutcome {
  state: KeyTableState
  action: KeyTableAction
}

export function initialKeyTable(): KeyTableState {
  return { mode: 'root', since: 0 }
}

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Dead', 'Process', 'Unidentified'])
const NAMED: Record<string, string> = { ' ': 'Space', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down' }

/** A press as a table key ('%', 'z', 'Space', 'Left'), or null for a modifier or dead key. */
export function tableKeyOf(p: Pick<Press, 'key'>): string | null {
  if (MODIFIER_KEYS.has(p.key)) return null
  return NAMED[p.key] ?? p.key
}

/** Whether `key` is something the table can hold: one character, or a name. */
function isTableKey(key: string): boolean {
  return [...key].length === 1 || Object.values(NAMED).includes(key) || ['Enter', 'Escape', 'Tab', 'Backspace'].includes(key)
}

/** The table: the defaults, with the user's `prefix:<key>` bindings in place of their commands' defaults. */
export function buildTable(overrides: Readonly<Record<string, string | null>> | undefined): Record<string, string> {
  const table: Record<string, string> = { ...DEFAULT_TABLE }
  for (const [id, value] of Object.entries(overrides ?? {})) {
    if (typeof value !== 'string' || !value.startsWith('prefix:')) continue
    const key = value.slice('prefix:'.length)
    if (!isTableKey(key)) continue
    for (const [k, v] of Object.entries(table)) if (v === id) delete table[k]
    table[key] = id
  }
  return table
}

const toKeyLike = (p: Press) => ({ key: p.key, code: p.code, metaKey: p.meta, ctrlKey: p.ctrl, altKey: p.alt, shiftKey: p.shift })

/** One key press against the key-table. */
export function keyTableStep(prev: KeyTableState, p: Press, cfg: KeyTableConfig, now: number): KeyTableOutcome {
  const root: KeyTableState = { mode: 'root', since: 0 }
  if (cfg.prefix === null) return { state: root, action: { type: 'pass' } }
  // A press mid-composition belongs to the input method; it also ends any pending prefix.
  if (p.isComposing) return { state: root, action: { type: 'pass' } }

  let state = prev
  if (state.mode === 'prefix' && now - state.since > PREFIX_TIMEOUT_MS) state = root

  if (state.mode === 'root') {
    if (keyMatchesAccelerator(toKeyLike(p), cfg.prefix)) return { state: { mode: 'prefix', since: now }, action: { type: 'swallow' } }
    return { state: root, action: { type: 'pass' } }
  }

  // In prefix mode.
  const key = tableKeyOf(p)
  if (key === null) return { state, action: { type: 'pass' } } // a bare modifier: keep waiting
  if (keyMatchesAccelerator(toKeyLike(p), cfg.prefix)) return { state: root, action: { type: 'literal' } }
  if (key === 'Escape') return { state: root, action: { type: 'swallow' } }
  const id = p.ctrl || p.meta || p.alt ? undefined : cfg.table[key]
  return { state: root, action: id === undefined ? { type: 'swallow' } : { type: 'command', id } }
}

/**
 * Whether the keyboard is in a terminal pane: xterm's own input inside a pane. Never the find
 * box, Settings, a note editor or any other input, or Ctrl-a would break there.
 */
export function isTerminalFocus(el: Element | null): boolean {
  return el !== null && el.classList.contains('xterm-helper-textarea') && el.closest('.xterm-pane') !== null
}

/**
 * What "prefix twice" types into the pane: the control character for a Ctrl+letter prefix
 * (Ctrl+A is \x01, beginning-of-line). A prefix that is not Ctrl+letter has no such byte.
 */
export function prefixLiteral(prefix: string | null): string | null {
  const m = prefix === null ? null : /^Ctrl\+([A-Za-z])$/.exec(prefix)
  return m === null ? null : String.fromCharCode((m[1] as string).toUpperCase().charCodeAt(0) - 64)
}
