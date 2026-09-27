import { useState } from 'preact/hooks'
import { formatEnvLines, launcherIdFor, parseEnvLines } from '../lib/launchers'
import { AgentMark } from './icons'

export type EditorSetting = { kind: 'vscode' | 'cursor' | 'zed' | 'custom' | 'cockpit'; command?: string }
export type LauncherSetting = {
  id: string
  label: string
  command: string
  env: Record<string, string>
  enabled: boolean
  builtin: boolean
}
export type UserSettings = { launchers: LauncherSetting[]; editor: EditorSetting; layouts: Record<string, unknown> }

const EDITORS: Array<{ kind: EditorSetting['kind']; label: string }> = [
  { kind: 'vscode', label: 'VS Code' },
  { kind: 'cursor', label: 'Cursor' },
  { kind: 'zed', label: 'Zed' },
  { kind: 'cockpit', label: 'In the cockpit' },
  { kind: 'custom', label: 'Custom command' },
]

/**
 * Settings (⌘,): the launchers a new session can start with — each one's name, the one
 * line typed into the shell, and extra environment — and which editor Cmd+click opens.
 * Saved per user by the daemon, which validates everything again; this form only shows
 * its answer.
 */
export type NotifyPrefs = { sound: boolean; dockBadge: boolean }

export function SettingsPanel({ initial, availability, defaults, notify, onNotify, onSave, onClose }: {
  initial: UserSettings
  /** Launcher id → whether this machine has its program (from launchers.list). */
  availability: Record<string, boolean>
  /** The shipped form of each built-in, for Reset. */
  defaults: Record<string, { label: string; command: string }>
  /** This window's own notification choices: applied at once, not with Save. */
  notify: NotifyPrefs
  onNotify: (next: NotifyPrefs) => void
  onSave: (next: UserSettings) => Promise<string | null>
  onClose: () => void
}) {
  const [draft, setDraft] = useState<UserSettings>(initial)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  /** The env textarea as typed, per launcher, until it parses. */
  const [envText, setEnvText] = useState<Record<string, string>>({})

  const update = (id: string, patch: Partial<LauncherSetting>): void => {
    setDraft({ ...draft, launchers: draft.launchers.map((l) => (l.id === id ? { ...l, ...patch } : l)) })
  }

  const addLauncher = (): void => {
    const id = launcherIdFor('My launcher', draft.launchers.map((l) => l.id))
    setDraft({ ...draft, launchers: [...draft.launchers, { id, label: 'My launcher', command: '', env: {}, enabled: true, builtin: false }] })
    setOpen(id)
  }

  const save = async (): Promise<void> => {
    // Every env box must parse before anything is sent.
    for (const [id, text] of Object.entries(envText)) {
      const parsed = parseEnvLines(text)
      if (!parsed.ok) {
        setOpen(id)
        setError(`${draft.launchers.find((l) => l.id === id)?.label ?? id}: ${parsed.error}`)
        return
      }
    }
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

        <h3 class="cockpit-settings__heading">Launchers</h3>
        <p class="cockpit-muted">
          What a new session can start with. The command is typed into the session's shell, in its
          worktree; when it exits you are back at the prompt. Your aliases and wrappers work (e.g. <code>cx</code>).
        </p>
        <ul class="cockpit-launchers">
          {draft.launchers.map((l) => {
            const available = availability[l.id]
            const expanded = open === l.id
            return (
              <li key={l.id} class={`cockpit-launcher${expanded ? ' is-open' : ''}`}>
                <div class="cockpit-launcher__row">
                  <input type="checkbox" checked={l.enabled} aria-label={`${l.label} on`}
                    onChange={(e) => update(l.id, { enabled: (e.target as HTMLInputElement).checked })} />
                  <AgentMark agent={l.id} />
                  <span class="cockpit-launcher__label">{l.label}</span>
                  <code class="cockpit-launcher__command">{l.command || '—'}</code>
                  <span class={`cockpit-launcher__state${available ? ' is-ok' : ''}`}>
                    {available === undefined ? 'unsaved' : available ? 'installed' : 'not installed'}
                  </span>
                  <button type="button" class="cockpit-btn cockpit-btn--sm cockpit-launcher__edit" aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? null : l.id)}>{expanded ? 'Done' : 'Edit'}</button>
                </div>
                {expanded ? (
                  <div class="cockpit-launcher__form">
                    <label class="cockpit-picker__field">
                      <span class="cockpit-muted">Name</span>
                      <input value={l.label} onInput={(e) => update(l.id, { label: (e.target as HTMLInputElement).value })} />
                    </label>
                    <label class="cockpit-picker__field">
                      <span class="cockpit-muted">Command — one line, flags included</span>
                      <input class="cockpit-settings__command" value={l.command} spellcheck={false}
                        placeholder="claude --model opus --dangerously-skip-permissions"
                        onInput={(e) => update(l.id, { command: (e.target as HTMLInputElement).value })} />
                    </label>
                    <label class="cockpit-picker__field">
                      <span class="cockpit-muted">Environment — NAME=value per line</span>
                      <textarea class="cockpit-settings__env" rows={3} spellcheck={false}
                        value={envText[l.id] ?? formatEnvLines(l.env)}
                        placeholder={'ANTHROPIC_MODEL=claude-opus\nHTTPS_PROXY=http://127.0.0.1:8080'}
                        onInput={(e) => {
                          const text = (e.target as HTMLTextAreaElement).value
                          setEnvText({ ...envText, [l.id]: text })
                          const parsed = parseEnvLines(text)
                          if (parsed.ok) update(l.id, { env: parsed.env })
                        }} />
                    </label>
                    <div class="cockpit-launcher__actions">
                      {l.builtin ? (
                        <button type="button" class="cockpit-btn cockpit-btn--sm" onClick={() => {
                          const d = defaults[l.id]
                          if (d) update(l.id, { label: d.label, command: d.command, env: {} })
                          const rest = { ...envText }
                          delete rest[l.id]
                          setEnvText(rest)
                        }}>Reset to default</button>
                      ) : (
                        <button type="button" class="cockpit-btn cockpit-btn--sm cockpit-btn--danger" onClick={() => {
                          setDraft({ ...draft, launchers: draft.launchers.filter((x) => x.id !== l.id) })
                          setOpen(null)
                        }}>Delete</button>
                      )}
                    </div>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
        <button type="button" class="cockpit-btn cockpit-btn--ghost cockpit-launchers__add" onClick={addLauncher}>+ Add launcher</button>

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

        <h3 class="cockpit-settings__heading">When a session waits for you</h3>
        <p class="cockpit-muted">A desktop notification when the window is not in front; these apply right away.</p>
        <label class="cockpit-settings__toggle">
          <input type="checkbox" checked={notify.sound} onChange={(e) => onNotify({ ...notify, sound: (e.target as HTMLInputElement).checked })} />
          <span>Play a sound</span>
        </label>
        <label class="cockpit-settings__toggle">
          <input type="checkbox" checked={notify.dockBadge} onChange={(e) => onNotify({ ...notify, dockBadge: (e.target as HTMLInputElement).checked })} />
          <span>Count them on the Dock icon</span>
        </label>

        {error ? <p class="cockpit-error" role="alert">{error}</p> : null}
        <div class="cockpit-picker__actions">
          <button type="button" class="cockpit-btn" onClick={onClose}>Cancel</button>
          <button type="button" class="cockpit-btn cockpit-btn--primary" disabled={saving} onClick={() => { void save() }}>Save</button>
        </div>
      </div>
    </div>
  )
}
