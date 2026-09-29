import { describe, expect, test } from 'bun:test'
import {
  acceleratorFromKey, COMMANDS, effectiveKeys, formatAccelerator, isAccelerator, isCommandId, keyConflicts, keyMatchesAccelerator, menuLessBindings, normalizeAccelerator,
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

describe('commands without a menu item', () => {
  test('exist, are bindable, and have no default shortcut', () => {
    const menuless = COMMANDS.filter((c) => c.menu === null)
    expect(menuless.length).toBeGreaterThan(0)
    expect(menuless.map((c) => c.id)).toContain('cycle-layout')
    expect(effectiveKeys(undefined)['cycle-layout']).toBeNull()
    // the user's own binding takes effect and is checked for conflicts like any other
    const keys = effectiveKeys({ 'cycle-layout': 'CmdOrCtrl+Alt+Space' })
    expect(keys['cycle-layout']).toBe('CmdOrCtrl+Alt+Space')
    expect(keyConflicts({ ...keys, 'zoom-pane': 'CmdOrCtrl+Alt+Space' })).toHaveLength(1)
  })

  test('menuLessBindings lists exactly the bound menu-less commands, with the accelerator to listen for', () => {
    expect(menuLessBindings(effectiveKeys(undefined))).toEqual([])
    expect(menuLessBindings(effectiveKeys({ 'cycle-layout': 'CmdOrCtrl+Alt+Space', 'split-right': 'CmdOrCtrl+Alt+D' })))
      .toEqual([{ id: 'cycle-layout', accelerator: 'CmdOrCtrl+Alt+Space' }])
  })
})

describe('keyMatchesAccelerator', () => {
  const press = (over: Partial<{ key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>) =>
    ({ key: 'x', code: 'KeyX', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over })

  test('a key press spelling the same chord matches, whatever the accelerator\'s spelling', () => {
    expect(keyMatchesAccelerator(press({ code: 'Space', key: ' ', metaKey: true, altKey: true }), 'CmdOrCtrl+Alt+Space')).toBe(true)
    expect(keyMatchesAccelerator(press({ code: 'Space', key: ' ', metaKey: true, altKey: true }), 'Alt+Command+Space')).toBe(true)
    expect(keyMatchesAccelerator(press({ code: 'KeyD', key: 'D', metaKey: true, shiftKey: true }), 'CmdOrCtrl+Shift+D')).toBe(true)
  })

  test('a different key or modifier does not, and neither does a bare modifier press', () => {
    expect(keyMatchesAccelerator(press({ code: 'KeyD', metaKey: true }), 'CmdOrCtrl+Shift+D')).toBe(false)
    expect(keyMatchesAccelerator(press({ code: 'KeyE', metaKey: true, shiftKey: true }), 'CmdOrCtrl+Shift+D')).toBe(false)
    expect(keyMatchesAccelerator(press({ code: 'MetaLeft', key: 'Meta', metaKey: true }), 'CmdOrCtrl+D')).toBe(false)
  })

  test('Option-modified letters match on the physical key, not the glyph they type', () => {
    expect(keyMatchesAccelerator(press({ code: 'KeyD', key: '∂', metaKey: true, altKey: true }), 'CmdOrCtrl+Alt+D')).toBe(true)
  })
})
