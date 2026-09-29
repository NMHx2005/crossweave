import { describe, expect, test } from 'bun:test'
import {
  buildTable, DEFAULT_PREFIX, DEFAULT_TABLE, initialKeyTable, isTerminalFocus, keyTableStep, PREFIX_TIMEOUT_MS, tableKeyOf,
  type KeyTableConfig, type KeyTableState, type Press,
} from '../src/lib/keytable'

const press = (over: Partial<Press>): Press => ({ key: 'x', code: 'KeyX', ctrl: false, meta: false, alt: false, shift: false, isComposing: false, ...over })
const PREFIX = press({ key: 'a', code: 'KeyA', ctrl: true })
const cfg = (over: Partial<KeyTableConfig> = {}): KeyTableConfig => ({ prefix: DEFAULT_PREFIX, table: buildTable(undefined), ...over })

function feed(presses: Array<[Press, number?]>, config = cfg()): { state: KeyTableState; actions: string[] } {
  let state = initialKeyTable()
  const actions: string[] = []
  let t = 1000
  for (const [p, at] of presses) {
    t = at ?? t + 10
    const r = keyTableStep(state, p, config, t)
    state = r.state
    actions.push(r.action.type === 'command' ? `command:${r.action.id}` : r.action.type)
  }
  return { state, actions }
}

describe('the prefix', () => {
  test('outside prefix mode a key passes through untouched', () => {
    expect(feed([[press({ key: 'l' })]]).actions).toEqual(['pass'])
    expect(feed([[press({ key: 'a', code: 'KeyA', meta: true })]]).actions).toEqual(['pass']) // ⌘A is select-all
  })

  test('the prefix chord enters prefix mode and is swallowed (it never reaches the shell)', () => {
    const r = feed([[PREFIX]])
    expect(r.actions).toEqual(['swallow'])
    expect(r.state.mode).toBe('prefix')
  })

  test('the next key resolves against the table, then the mode is back to root', () => {
    const r = feed([[PREFIX], [press({ key: '%', code: 'Digit5', shift: true })]])
    expect(r.actions).toEqual(['swallow', 'command:split-right'])
    expect(r.state.mode).toBe('root')
    expect(feed([[PREFIX], [press({ key: '"', code: 'Quote', shift: true })]]).actions[1]).toBe('command:split-down')
  })

  test('prefix twice sends a literal prefix (Ctrl-a, beginning-of-line) to the pane', () => {
    const r = feed([[PREFIX], [PREFIX]])
    expect(r.actions).toEqual(['swallow', 'literal'])
    expect(r.state.mode).toBe('root')
  })

  test('the table matches event.key, so punctuation works on any layout and case matters', () => {
    expect(feed([[PREFIX], [press({ key: 'z' })]]).actions[1]).toBe('command:zoom-pane')
    expect(feed([[PREFIX], [press({ key: 'Z', shift: true })]]).actions[1]).toBe('swallow') // capital Z is not bound
    expect(feed([[PREFIX], [press({ key: '[', code: 'BracketLeft' })]]).actions[1]).toBe('command:copy-mode')
    expect(feed([[PREFIX], [press({ key: ' ', code: 'Space' })]]).actions[1]).toBe('command:cycle-layout')
    expect(feed([[PREFIX], [press({ key: 'ArrowLeft', code: 'ArrowLeft' })]]).actions[1]).toBe('command:focus-left')
  })

  test('an unbound key leaves prefix mode and is swallowed', () => {
    const r = feed([[PREFIX], [press({ key: 'q', code: 'KeyQ' })]])
    expect(r.actions).toEqual(['swallow', 'swallow'])
    expect(r.state.mode).toBe('root')
  })

  test('Escape leaves prefix mode without doing anything', () => {
    const r = feed([[PREFIX], [press({ key: 'Escape', code: 'Escape' })]])
    expect(r.actions).toEqual(['swallow', 'swallow'])
    expect(r.state.mode).toBe('root')
  })

  test('a bare modifier press in prefix mode is ignored and the mode stays', () => {
    const r = feed([[PREFIX], [press({ key: 'Shift', code: 'ShiftLeft', shift: true })], [press({ key: 'z' })]])
    expect(r.actions).toEqual(['swallow', 'pass', 'command:zoom-pane'])
  })

  test('IME composition is never intercepted, and it ends prefix mode', () => {
    const r = feed([[PREFIX], [press({ key: 'a', isComposing: true })]])
    expect(r.actions[1]).toBe('pass')
    expect(r.state.mode).toBe('root')
    expect(feed([[press({ key: 'a', code: 'KeyA', ctrl: true, isComposing: true })]]).actions).toEqual(['pass'])
  })

  test('after the timeout prefix mode has lapsed: the key is an ordinary key again', () => {
    const r = feed([[PREFIX, 1000], [press({ key: 'z' }), 1000 + PREFIX_TIMEOUT_MS + 1]])
    expect(r.actions).toEqual(['swallow', 'pass'])
    expect(r.state.mode).toBe('root')
    const soon = feed([[PREFIX, 1000], [press({ key: 'z' }), 1000 + PREFIX_TIMEOUT_MS - 1]])
    expect(soon.actions[1]).toBe('command:zoom-pane')
  })

  test('no prefix configured (unbound): nothing is ever intercepted', () => {
    expect(feed([[PREFIX]], cfg({ prefix: null })).actions).toEqual(['pass'])
  })

  test('a rebound prefix works and the old one no longer does', () => {
    const c = cfg({ prefix: 'Ctrl+B' })
    expect(feed([[PREFIX]], c).actions).toEqual(['pass'])
    expect(feed([[press({ key: 'b', code: 'KeyB', ctrl: true })], [press({ key: 'z' })]], c).actions).toEqual(['swallow', 'command:zoom-pane'])
  })
})

describe('the table', () => {
  test('the defaults are tmux\'s keys, mapped to commands that exist', async () => {
    const { COMMANDS } = await import('../src/lib/keymap')
    const ids = new Set(COMMANDS.map((c) => c.id))
    for (const [k, id] of Object.entries(DEFAULT_TABLE)) expect(ids.has(id), `${k} → ${id}`).toBe(true)
    expect(DEFAULT_TABLE['%']).toBe('split-right')
    expect(DEFAULT_TABLE['x']).toBe('close-pane')
  })

  test('a user binding of the form prefix:<key> adds an entry and replaces the command\'s default', () => {
    const t = buildTable({ 'split-right': 'prefix:|' })
    expect(t['|']).toBe('split-right')
    expect(Object.entries(t).filter(([, id]) => id === 'split-right')).toHaveLength(1)
    expect(t['%']).toBeUndefined()
  })

  test('a user binding to a key that another command has takes it over; the loser keeps its other keys', () => {
    const t = buildTable({ 'split-down': 'prefix:%' })
    expect(t['%']).toBe('split-down')
    expect(t['"']).toBeUndefined()
  })

  test('ordinary accelerators and unbinding do not touch the table', () => {
    expect(buildTable({ 'split-right': 'CmdOrCtrl+Alt+D', 'zoom-pane': null })).toEqual(DEFAULT_TABLE)
  })

  test('a malformed prefix binding is ignored', () => {
    expect(buildTable({ 'split-right': 'prefix:', 'zoom-pane': 'prefix:zz' })).toEqual(DEFAULT_TABLE)
  })
})

describe('tableKeyOf', () => {
  test('names the keys the way the table and the settings recorder do', () => {
    expect(tableKeyOf(press({ key: ' ' }))).toBe('Space')
    expect(tableKeyOf(press({ key: 'ArrowUp' }))).toBe('Up')
    expect(tableKeyOf(press({ key: 'Enter' }))).toBe('Enter')
    expect(tableKeyOf(press({ key: '%' }))).toBe('%')
    expect(tableKeyOf(press({ key: 'Shift' }))).toBeNull()
    expect(tableKeyOf(press({ key: 'Dead' }))).toBeNull()
  })
})

describe('where it is allowed to intercept', () => {
  const el = (over: { inPane?: boolean; textarea?: boolean; tag?: string }) => ({
    tagName: over.tag ?? 'TEXTAREA',
    classList: { contains: (c: string) => c === 'xterm-helper-textarea' && (over.textarea ?? true) },
    closest: (sel: string) => (sel === '.xterm-pane' && (over.inPane ?? true) ? {} : null),
  })

  test('only while a terminal pane has the keyboard', () => {
    expect(isTerminalFocus(el({}) as unknown as Element)).toBe(true)
  })

  test('never in the find box, Settings, a note editor or any other input', () => {
    expect(isTerminalFocus(el({ inPane: false, textarea: false, tag: 'INPUT' }) as unknown as Element)).toBe(false)
    expect(isTerminalFocus(el({ inPane: false }) as unknown as Element)).toBe(false) // a textarea outside a pane
    expect(isTerminalFocus(el({ textarea: false }) as unknown as Element)).toBe(false) // inside the pane but not its input
    expect(isTerminalFocus(null)).toBe(false)
  })
})

describe('prefixLiteral', () => {
  test('a Ctrl+letter prefix types its control character; anything else has none', async () => {
    const { prefixLiteral } = await import('../src/lib/keytable')
    expect(prefixLiteral('Ctrl+A')).toBe('\x01')
    expect(prefixLiteral('Ctrl+b')).toBe('\x02')
    expect(prefixLiteral('CmdOrCtrl+A')).toBeNull()
    expect(prefixLiteral(null)).toBeNull()
  })
})
