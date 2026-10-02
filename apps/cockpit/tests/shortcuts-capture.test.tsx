/** @jsxImportSource preact */
import { describe, expect, test } from 'bun:test'
import type { ComponentChildren, VNode } from 'preact'
import { ShortcutCaptureDialog } from '../src/ui/ShortcutsPanel'
import { effectiveKeys, shortcutFromKey, type ShortcutCapture } from '../src/lib/keymap'
import { tableKeyOf } from '../src/lib/keytable'

/**
 * The capture is a DIALOG, never in-place editing; the keydown rules are pinned as
 * the pure `shortcutFromKey` (keymap) and the dialog as its own unit. ShortcutList
 * itself uses hooks (no DOM in this runner — its mounted look is verified in the
 * running app, per the house's definition of done).
 */

type Found = { texts: string[]; nodes: VNode[] }
function walk(node: ComponentChildren, out: Found = { texts: [], nodes: [] }): Found {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') { out.texts.push(String(node)); return out }
  if (Array.isArray(node)) { for (const n of node) walk(n, out); return out }
  const v = node as VNode<Record<string, unknown>>
  if (typeof v.type === 'function') return walk((v.type as (p: unknown) => ComponentChildren)(v.props), out)
  out.nodes.push(v)
  return walk(v.props['children'] as ComponentChildren, out)
}
const text = (f: Found): string => f.texts.join(' ').replace(/\s+/g, ' ')
const buttonNodes = (f: Found, label: string): VNode[] =>
  f.nodes.filter((n) => n.type === 'button' && walk(n).texts.join(' ').includes(label))

const key = (code: string, over: Partial<KeyboardEvent> = {}): KeyboardEvent =>
  ({ key: code, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false,
    preventDefault: () => undefined, stopPropagation: () => undefined, ...over }) as unknown as KeyboardEvent

describe('ShortcutCaptureDialog', () => {
  const dialog = (over: Partial<Parameters<typeof ShortcutCaptureDialog>[0]> = {}): Found => walk(
    <ShortcutCaptureDialog
      commandId="session.new"
      label="New Session…"
      keybinding="CmdOrCtrl+T"
      changed={true}
      prefix="Ctrl+A"
      awaiting={false}
      onKey={() => undefined}
      onClear={() => undefined}
      onReset={() => undefined}
      onCancel={() => undefined}
      {...over}
    />,
  )

  test('title, capture surface, the prefix hint, and its three actions', () => {
    const f = dialog()
    expect(text(f)).toContain('New Session…')
    expect(text(f)).toContain('Press keys… (Esc cancels)')
    expect(text(f)).toContain('The prefix, then a key, records a key-table binding.')
    expect(buttonNodes(f, 'None')).toHaveLength(1)
    expect(buttonNodes(f, 'Reset')).toHaveLength(1)
    expect(buttonNodes(f, 'Cancel')).toHaveLength(1)
  })

  test('no keybinding → no None; no override → no Reset', () => {
    expect(buttonNodes(dialog({ keybinding: null, changed: false }), 'None')).toHaveLength(0)
    expect(buttonNodes(dialog({ keybinding: null, changed: false }), 'Reset')).toHaveLength(0)
  })

  test('awaiting shows the prefix-then-key prompt', () => {
    expect(text(dialog({ awaiting: true }))).toContain('⌃A then press the key…')
  })

  test('the record surface answers keydown through the pure rules', () => {
    const captures: ShortcutCapture[] = []
    const f = dialog({ onKey: (c) => captures.push(c) })
    const record = buttonNodes(f, 'Press keys…')[0]
    const onKey = record?.props['onKeyDown'] as (ev: KeyboardEvent) => void
    onKey(key('Escape'))
    onKey(key('KeyA', { key: 'a', ctrlKey: true })) // the prefix chord → await
    onKey(key('KeyK', { key: 'k', metaKey: true, code: 'KeyK' }))
    expect(captures).toEqual([
      { kind: 'cancel' },
      { kind: 'await' },
      { kind: 'record', key: 'CmdOrCtrl+K' },
    ])
  })
})

describe('shortcutFromKey (pure rules)', () => {
  test('escape cancels; a bare modifier is ignored; the prefix awaits; a table key records prefix:key', () => {
    expect(shortcutFromKey(key('Escape'), { commandId: 'x', prefix: null, awaiting: false })).toEqual({ kind: 'cancel' })
    expect(shortcutFromKey(key('ShiftLeft'), { commandId: 'x', prefix: null, awaiting: false })).toEqual({ kind: 'ignore' })
    expect(shortcutFromKey(key('KeyA', { key: 'a', ctrlKey: true }), { commandId: 'x', prefix: 'Ctrl+A', awaiting: false, tableKeyOf })).toEqual({ kind: 'await' })
    expect(shortcutFromKey(key('KeyD', { key: 'd' }), { commandId: 'x', prefix: 'Ctrl+A', awaiting: true, tableKeyOf })).toEqual({ kind: 'record', key: 'prefix:d' })
    // The prefix command itself records directly (no sequence of its own).
    expect(shortcutFromKey(key('KeyA', { key: 'a', ctrlKey: true }), { commandId: 'prefix', prefix: 'Ctrl+A', awaiting: false, tableKeyOf })).toEqual({ kind: 'record', key: 'Ctrl+A' })
  })
})

describe('effectiveKeys (the row view)', () => {
  test('an override replaces, None clears, the default stands otherwise', () => {
    expect(effectiveKeys({ 'new-agent': null })['new-agent']).toBeNull()
    expect(effectiveKeys({})['new-agent']).toBe('CmdOrCtrl+T')
  })
})
