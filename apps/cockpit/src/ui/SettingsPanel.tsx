import { useState } from 'preact/hooks'
import type { AgentOption } from '../host/cockpit-api'

export type AgentSetting = { id: string; label: string; command: string; enabled: boolean; builtin: boolean }
export type EditorSetting = { kind: 'vscode' | 'cursor' | 'zed' | 'custom' | 'cockpit'; command?: string }
export type UserSettings = { agents: AgentSetting[]; editor: EditorSetting; layouts: Record<string, unknown> }

const EDITORS: Array<{ kind: EditorSetting['kind']; label: string }> = [
  { kind: 'vscode', label: 'VS Code' },
  { kind: 'cursor', label: 'Cursor' },
  { kind: 'zed', label: 'Zed' },
  { kind: 'cockpit', label: 'In the cockpit' },
  { kind: 'custom', label: 'Custom command' },
]

/**
 * Settings (⌘,): which agents exist and how they launch, and which editor Cmd+click
 * opens. Saved per user by the daemon, which validates everything again — this form
 * only shows its answer. A command is split into arguments, never run through a shell.
 */
export function SettingsPanel({ initial, agents, onSave, onClose }: {
  initial: UserSettings
  /** Tier and availability, from agents.list. */
  agents: AgentOption[]
  onSave: (next: UserSettings) => Promise<string | null>
  onClose: () => void
}) {
  const [draft, setDraft] = useState<UserSettings>(initial)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [newAgent, setNewAgent] = useState({ id: '', label: '', command: '' })
  const info = new Map(agents.map((a) => [a.id, a]))

  const updateAgent = (id: string, patch: Partial<AgentSetting>): void => {
    setDraft({ ...draft, agents: draft.agents.map((a) => (a.id === id ? { ...a, ...patch } : a)) })
  }
  const addAgent = (): void => {
    const id = newAgent.id.trim()
    if (id === '' || newAgent.command.trim() === '') {
      setError('A new agent needs an id and a command')
      return
    }
    setDraft({ ...draft, agents: [...draft.agents, { id, label: newAgent.label.trim() || id, command: newAgent.command.trim(), enabled: true, builtin: false }] })
    setNewAgent({ id: '', label: '', command: '' })
    setError(null)
  }
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

        <h3 class="cockpit-settings__heading">Agents</h3>
        <p class="cockpit-muted">
          Commands run as typed, split into arguments (no shell). Only Claude Code is guarded; every
          other agent is advisory.
        </p>
        <div class="cockpit-settings__agents">
          {draft.agents.map((agent) => {
            const meta = info.get(agent.id)
            return (
              <div class="cockpit-settings__agent" key={agent.id}>
                <label class="cockpit-settings__toggle">
                  <input
                    type="checkbox"
                    checked={agent.enabled}
                    onChange={(e) => updateAgent(agent.id, { enabled: (e.target as HTMLInputElement).checked })}
                  />
                  <span>{agent.label}</span>
                </label>
                <span class="cockpit-muted">
                  {meta === undefined ? 'custom' : meta.available ? (meta.tier === 'T2' || meta.tier === 'T1' ? 'guarded' : 'advisory') : 'not installed'}
                </span>
                <input
                  class="cockpit-settings__command"
                  value={agent.command}
                  spellcheck={false}
                  aria-label={`${agent.label} command`}
                  onInput={(e) => updateAgent(agent.id, { command: (e.target as HTMLInputElement).value })}
                />
                {!agent.builtin ? (
                  <button type="button" aria-label={`Remove ${agent.label}`}
                    onClick={() => setDraft({ ...draft, agents: draft.agents.filter((a) => a.id !== agent.id) })}>×</button>
                ) : <span />}
              </div>
            )
          })}
          <div class="cockpit-settings__agent">
            <input placeholder="id" aria-label="New agent id" spellcheck={false} value={newAgent.id}
              onInput={(e) => setNewAgent({ ...newAgent, id: (e.target as HTMLInputElement).value })} />
            <input placeholder="Label" aria-label="New agent label" value={newAgent.label}
              onInput={(e) => setNewAgent({ ...newAgent, label: (e.target as HTMLInputElement).value })} />
            <input class="cockpit-settings__command" placeholder="command --and-args" aria-label="New agent command" spellcheck={false}
              value={newAgent.command} onInput={(e) => setNewAgent({ ...newAgent, command: (e.target as HTMLInputElement).value })} />
            <button type="button" onClick={addAgent}>Add</button>
          </div>
        </div>

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

        {error ? <p class="cockpit-error" role="alert">{error}</p> : null}
        <div class="cockpit-picker__actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" class="is-primary" disabled={saving} onClick={() => { void save() }}>Save</button>
        </div>
      </div>
    </div>
  )
}
