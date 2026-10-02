import { useState } from 'preact/hooks'
import { COMMANDS, effectiveKeys, formatAccelerator, formatBinding, keyConflicts, shortcutFromKey, type MenuName, type ShortcutCapture } from '../lib/keymap'
import { buildTable, tableKeyOf } from '../lib/keytable'

/** `null` is the commands with no menu item: listed last, as "Other". */
const MENUS: Array<MenuName | null> = ['Session', 'Pane', 'File', 'Edit', 'View', 'Help', null]

/**
 * Every command and its shortcut, grouped by menu. Editable in Settings (record a new
 * chord, unbind, reset), read-only as Help → Keyboard Shortcuts. Two commands on one
 * chord are called out, and Settings refuses to save them.
 *
 * "Change" opens a capture DIALOG — the row itself is never edited in place: the
 * list stays a table while a chord is being recorded.
 */
/** The capture dialog itself — testable as its own unit; the rows never host it. */
export function ShortcutCaptureDialog({ commandId, label, keybinding, changed, prefix, awaiting, onKey, onClear, onReset, onCancel }: {
  commandId: string
  label: string
  keybinding: string | null
  /** True when the user has an override for this command (a Reset is offered). */
  changed: boolean
  prefix: string | null
  awaiting: boolean
  onKey: (capture: ShortcutCapture) => void
  onClear: () => void
  onReset: () => void
  onCancel: () => void
}) {
  return (
    <div class="cockpit-picker__backdrop" onClick={onCancel}>
      <div class="cockpit-picker cockpit-shortcuts__capture" role="dialog" aria-label={`Change shortcut: ${label}`}
        onClick={(ev) => ev.stopPropagation()}>
        <h2 class="cockpit-picker__title">{label}</h2>
        <button type="button" class="cockpit-btn cockpit-shortcuts__record is-recording" autoFocus
          onKeyDown={(ev) => {
            ev.preventDefault()
            ev.stopPropagation()
            onKey(shortcutFromKey(ev, { commandId, prefix, awaiting, tableKeyOf }))
          }}>
          {awaiting ? `${formatAccelerator(prefix)} then press the key…` : 'Press keys… (Esc cancels)'}
        </button>
        <p class="cockpit-shortcuts__capture-hint">
          The prefix, then a key, records a key-table binding.
        </p>
        <div class="cockpit-picker__actions">
          {keybinding ? <button type="button" class="cockpit-btn" onClick={onClear}>None</button> : null}
          {changed ? <button type="button" class="cockpit-btn" onClick={onReset}>Reset</button> : null}
          <button type="button" class="cockpit-btn cockpit-btn--primary" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

export function ShortcutList({ keybindings, onChange }: {
  keybindings: Readonly<Record<string, string | null>> | undefined
  /** Absent: read-only. */
  onChange?: (next: Record<string, string | null>) => void
}) {
  const [query, setQuery] = useState('')
  const [recording, setRecording] = useState<{ id: string; label: string } | null>(null)
  /** The prefix was pressed while capturing: the next key completes a `prefix:<key>` binding. */
  const [awaiting, setAwaiting] = useState(false)
  const keys = effectiveKeys(keybindings)
  const conflicts = keyConflicts(keys)
  const prefix = keys['prefix'] ?? null
  const table = buildTable(keybindings)
  const clash = new Set(conflicts.flatMap((c) => c.ids))
  const q = query.trim().toLowerCase()

  const set = (id: string, key: string | null | undefined): void => {
    if (!onChange) return
    const next = { ...(keybindings ?? {}) }
    const spec = COMMANDS.find((c) => c.id === id)
    // Back to the default is no override at all.
    if (key === undefined || key === spec?.key) delete next[id]
    else next[id] = key
    onChange(next)
  }

  const close = (): void => { setRecording(null); setAwaiting(false) }

  return (
    <div class="cockpit-shortcuts">
      <input class="cockpit-shortcuts__filter" type="search" value={query} placeholder="Filter commands" aria-label="Filter commands"
        spellcheck={false} onInput={(ev) => setQuery((ev.target as HTMLInputElement).value)} />
      {conflicts.length > 0 ? (
        <p class="cockpit-error" role="alert">
          {conflicts.map((c) => `${formatAccelerator(c.key)} is on ${c.ids.map((id) => COMMANDS.find((x) => x.id === id)?.label ?? id).join(' and ')}`).join(' · ')}
        </p>
      ) : null}
      {MENUS.map((menu) => {
        const rows = COMMANDS.filter((c) => c.menu === menu && (q === '' || c.label.toLowerCase().includes(q) || formatAccelerator(keys[c.id] ?? null).toLowerCase().includes(q)))
        if (rows.length === 0) return null
        return (
          <section key={menu ?? 'other'}>
            <h4 class="cockpit-shortcuts__menu">{menu ?? 'Other'}</h4>
            <ul class="cockpit-shortcuts__list">
              {rows.map((c) => {
                const key = keys[c.id] ?? null
                const changed = keybindings?.[c.id] !== undefined
                return (
                  <li key={c.id} class={`cockpit-shortcuts__row${clash.has(c.id) ? ' is-clash' : ''}`}>
                    <span class="cockpit-shortcuts__label">{c.label}</span>
                    <kbd class="cockpit-shortcuts__key">{key ? formatBinding(key, prefix) : '—'}</kbd>
                    {c.id !== 'prefix' ? Object.entries(table).filter(([, id]) => id === c.id && !(key ?? '').startsWith('prefix:')).map(([k]) => (
                      <kbd key={k} class="cockpit-shortcuts__key cockpit-shortcuts__seq" title="Key-table: the prefix, then this key">{formatBinding(`prefix:${k}`, prefix)}</kbd>
                    )) : null}
                    {onChange ? (
                      <span class="cockpit-shortcuts__actions">
                        <button type="button" class="cockpit-btn cockpit-btn--sm cockpit-btn--ghost" onClick={() => { setRecording({ id: c.id, label: c.label }); setAwaiting(false) }}>Change</button>
                        {key ? <button type="button" class="cockpit-btn cockpit-btn--sm cockpit-btn--ghost" onClick={() => set(c.id, null)}>None</button> : null}
                        {changed ? <button type="button" class="cockpit-btn cockpit-btn--sm cockpit-btn--ghost" onClick={() => set(c.id, undefined)}>Reset</button> : null}
                      </span>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}
      {recording !== null ? (
        <ShortcutCaptureDialog
          commandId={recording.id}
          label={recording.label}
          keybinding={keys[recording.id] ?? null}
          changed={keybindings?.[recording.id] !== undefined}
          prefix={prefix}
          awaiting={awaiting}
          onKey={(capture) => {
            if (capture.kind === 'cancel') { close(); return }
            if (capture.kind === 'ignore') return
            if (capture.kind === 'await') { setAwaiting(true); return }
            set(recording.id, capture.key)
            close()
          }}
          onClear={() => { set(recording.id, null); close() }}
          onReset={() => { set(recording.id, undefined); close() }}
          onCancel={close}
        />
      ) : null}
    </div>
  )
}

/** Help → Keyboard Shortcuts (⌘/): the list, read-only. */
export function ShortcutsDialog({ keybindings, onClose, onEdit }: {
  keybindings: Readonly<Record<string, string | null>> | undefined
  onClose: () => void
  /** Opens Settings, where they are changed. */
  onEdit: () => void
}) {
  return (
    <div class="cockpit-picker__backdrop" onClick={onClose}>
      <div class="cockpit-picker cockpit-settings" role="dialog" aria-label="Keyboard shortcuts" onClick={(ev) => ev.stopPropagation()}
        onKeyDown={(ev) => { if (ev.code === 'Escape') onClose() }}>
        <h2 class="cockpit-picker__title">Keyboard shortcuts</h2>
        <ShortcutList keybindings={keybindings} />
        <div class="cockpit-picker__actions">
          <button type="button" class="cockpit-btn" onClick={onEdit}>Change in Settings…</button>
          <button type="button" class="cockpit-btn cockpit-btn--primary" autoFocus onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
