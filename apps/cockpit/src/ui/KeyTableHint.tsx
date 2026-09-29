import { COMMANDS, effectiveKeys, formatAccelerator } from '../lib/keymap'
import { buildTable } from '../lib/keytable'

const KEY_GLYPH: Record<string, string> = { Left: '←', Right: '→', Up: '↑', Down: '↓' }

/**
 * What the next key does, shown while the prefix is held: the key-table's bindings, each with
 * the command's own name. Read from the same table the listener resolves against.
 */
export function KeyTableHint({ keybindings }: { keybindings: Readonly<Record<string, string | null>> | undefined }) {
  const prefix = effectiveKeys(keybindings)['prefix'] ?? null
  const rows = Object.entries(buildTable(keybindings))
    .map(([key, id]) => ({ key, label: COMMANDS.find((c) => c.id === id)?.label ?? id }))
  return (
    <div class="cockpit-keyhint" role="status" aria-label="Prefix key">
      <div class="cockpit-keyhint__title">{prefix ? formatAccelerator(prefix) : 'Prefix'} then… <span class="cockpit-muted">Esc cancels · the prefix twice types it</span></div>
      <ul>
        {rows.map((r) => (
          <li key={r.key}><kbd>{KEY_GLYPH[r.key] ?? r.key}</kbd><span>{r.label}</span></li>
        ))}
      </ul>
    </div>
  )
}
