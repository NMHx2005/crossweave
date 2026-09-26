import { useState } from 'preact/hooks'

export type EditorSetting = { kind: 'vscode' | 'cursor' | 'zed' | 'custom' | 'cockpit'; command?: string }
export type UserSettings = { editor: EditorSetting; layouts: Record<string, unknown> }

const EDITORS: Array<{ kind: EditorSetting['kind']; label: string }> = [
  { kind: 'vscode', label: 'VS Code' },
  { kind: 'cursor', label: 'Cursor' },
  { kind: 'zed', label: 'Zed' },
  { kind: 'cockpit', label: 'In the cockpit' },
  { kind: 'custom', label: 'Custom command' },
]

/**
 * Settings (⌘,): which editor Cmd+click opens, and this viewer's cockpit preferences.
 * Saved per user by the daemon, which validates everything again — this form only
 * shows its answer. A custom editor command is split into arguments, never run
 * through a shell.
 */
export function SettingsPanel({ initial, onSave, onClose, showButtons, onShowButtons }: {
  initial: UserSettings
  onSave: (next: UserSettings) => Promise<string | null>
  onClose: () => void
  /** A cockpit preference of this viewer's, applied at once (not part of Save). */
  showButtons: boolean
  onShowButtons: (on: boolean) => void
}) {
  const [draft, setDraft] = useState<UserSettings>(initial)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const save = async (): Promise<void> => {
    setSaving(true)
    const problem = await onSave(draft)
    setSaving(false)
    if (problem === null) onClose()
    else setError(problem)
  }

  return (
    <div class="cockpit-picker__backdrop" onClick={onClose}>
      <div
        class="cockpit-picker cockpit-settings"
        role="dialog"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
      >
        <h2 class="cockpit-picker__title">Settings</h2>

        <h3 class="cockpit-settings__heading">Cmd+click opens files in</h3>
        <div class="cockpit-settings__editors" role="radiogroup" aria-label="Editor">
          {EDITORS.map((e) => (
            <label key={e.kind} class="cockpit-settings__toggle">
              <input
                type="radio"
                name="editor"
                checked={draft.editor.kind === e.kind}
                onChange={() => setDraft({ ...draft, editor: { kind: e.kind, ...(e.kind === 'custom' ? { command: draft.editor.command ?? '' } : {}) } })}
              />
              <span>{e.label}</span>
            </label>
          ))}
        </div>
        {draft.editor.kind === 'custom' ? (
          <label class="cockpit-picker__field">
            <span class="cockpit-muted">Command — {'{file}'}, {'{line}'} and {'{col}'} are filled in</span>
            <input
              value={draft.editor.command ?? ''}
              placeholder='subl "{file}:{line}:{col}"'
              spellcheck={false}
              onInput={(e) => setDraft({ ...draft, editor: { kind: 'custom', command: (e.target as HTMLInputElement).value } })}
            />
          </label>
        ) : null}

        <h3 class="cockpit-settings__heading">Cockpit</h3>
        <label class="cockpit-settings__toggle">
          <input type="checkbox" checked={showButtons}
            onChange={(e) => onShowButtons((e.target as HTMLInputElement).checked)} />
          <span>Show action buttons in the rail (⌘K runs every action as a command either way)</span>
        </label>

        {error ? <p class="cockpit-error" role="alert">{error}</p> : null}
        <div class="cockpit-picker__actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" class="is-primary" disabled={saving} onClick={() => { void save() }}>Save</button>
        </div>
      </div>
    </div>
  )
}
