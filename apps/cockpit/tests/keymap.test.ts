import { describe, expect, test } from 'bun:test'
import {
  acceleratorFromKey, COMMANDS, effectiveKeys, formatAccelerator, isAccelerator, isCommandId, keyConflicts, normalizeAccelerator,
} from '../src/lib/keymap'

describe('the command list', () => {
  test('ids are unique and the defaults do not collide', () => {
    expect(new Set(COMMANDS.map((c) => c.id)).size).toBe(COMMANDS.length)
    expect(keyConflicts(effectiveKeys(undefined))).toEqual([])
    expect(isCommandId('split-right')).toBe(true)
    expect(isCommandId('rm-rf')).toBe(false)
  })
})

describe('isAccelerator', () => {
  test('modifiers then one key; a bare key only for function keys', () => {
    for (const ok of ['CmdOrCtrl+K', 'CmdOrCtrl+Shift+Enter', 'Alt+Left', 'F5', 'Ctrl+,', 'CmdOrCtrl+\\', 'Cmd+Plus']) expect(isAccelerator(ok)).toBe(true)
    for (const bad of ['K', 'Shift+', 'CmdOrCtrl+Hyper+K', 'CmdOrCtrl+KK', 'Cmd+Cmd+K', '', 'CmdOrCtrl++']) expect(isAccelerator(bad)).toBe(false)
  })
})

describe('normalizeAccelerator / conflicts', () => {
  test('one spelling per chord, so differently written duplicates are caught', () => {
    expect(normalizeAccelerator('Shift+Command+D')).toBe('CmdOrCtrl+Shift+D')
    expect(normalizeAccelerator('Option+Return')).toBe('Alt+Enter')
    const keys = effectiveKeys({ 'split-right': 'Command+Shift+D' })
    expect(keyConflicts(keys)).toEqual([{ key: 'CmdOrCtrl+Shift+D', ids: ['split-right', 'split-down'] }])
  })

  test('an override replaces the default; null unbinds', () => {
    const keys = effectiveKeys({ 'command-bar': 'CmdOrCtrl+Shift+P', 'find': null })
    expect(keys['command-bar']).toBe('CmdOrCtrl+Shift+P')
    expect(keys.find).toBeNull()
    expect(keys['new-agent']).toBe('CmdOrCtrl+T')
  })
})

describe('formatAccelerator', () => {
  test('as a Mac shows it', () => {
    expect(formatAccelerator('CmdOrCtrl+Shift+D')).toBe('⌘⇧D')
    expect(formatAccelerator('CmdOrCtrl+Alt+Left')).toBe('⌘⌥←')
    expect(formatAccelerator('CmdOrCtrl+Shift+Enter')).toBe('⌘⇧↩')
    expect(formatAccelerator(null)).toBe('')
  })
})

describe('acceleratorFromKey', () => {
  const press = (code: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
    acceleratorFromKey({ key: '', code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods })

  test('physical keys with their modifiers; Option does not turn D into ∂', () => {
    expect(press('KeyD', { metaKey: true, altKey: true })).toBe('CmdOrCtrl+Alt+D')
    expect(press('ArrowLeft', { metaKey: true })).toBe('CmdOrCtrl+Left')
    expect(press('Slash', { metaKey: true })).toBe('CmdOrCtrl+/')
    expect(press('F5')).toBe('F5')
  })

  test('nothing for a bare letter, a modifier alone, or an unbindable key', () => {
    expect(press('KeyD')).toBeNull()
    expect(press('ShiftLeft', { shiftKey: true })).toBeNull()
    expect(press('IntlYen', { metaKey: true })).toBeNull()
  })
})
