import { useState } from 'preact/hooks'
import { acceleratorFromKey, COMMANDS, effectiveKeys, formatAccelerator, keyConflicts, type MenuName } from '../lib/keymap'

/** `null` is the commands with no menu item: listed last, as "Other". */
const MENUS: Array<MenuName | null> = ['Session', 'Pane', 'File', 'Edit', 'View', 'Help', null]

/**
 * Every command and its shortcut, grouped by menu. Editable in Settings (record a new
 * chord, unbind, reset), read-only as Help → Keyboard Shortcuts. Two commands on one
 * chord are called out, and Settings refuses to save them.
 */
export function ShortcutList({ keybindings, onChange }: {
  keybindings: Readonly<Record<string, string | null>> | undefined
  /** Absent: read-only. */
  onChange?: (next: Record<string, string | null>) => void
}) {
  const [query, setQuery] = useState('')
  const [recording, setRecording] = useState<string | null>(null)
  const keys = effectiveKeys(keybindings)
  const conflicts = keyConflicts(keys)
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
                    {onChange && recording === c.id ? (
                      <button type="button" class="cockpit-btn cockpit-btn--sm cockpit-shortcuts__record is-recording" autoFocus
                        onKeyDown={(ev) => {
                          ev.preventDefault()
                          ev.stopPropagation()
                          if (ev.code === 'Escape' && !ev.metaKey && !ev.ctrlKey && !ev.altKey && !ev.shiftKey) {
                            setRecording(null)
                            return
                          }
                          const accel = acceleratorFromKey(ev)
                          if (accel === null) return
                          set(c.id, accel)
                          setRecording(null)
                        }}
                        onBlur={() => setRecording(null)}>
                        Press keys… (Esc cancels)
                      </button>
                    ) : (
                      <kbd class="cockpit-shortcuts__key">{key ? formatAccelerator(key) : '—'}</kbd>
                    )}
                    {onChange ? (
                      <span class="cockpit-shortcuts__actions">
                        <button type="button" class="cockpit-btn cockpit-btn--sm cockpit-btn--ghost" onClick={() => setRecording(c.id)}>Change</button>
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
