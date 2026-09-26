import { useEffect, useRef, useState } from 'preact/hooks'
import type { AgentOption } from '../host/cockpit-api'
import { sessionNameError, suggestSessionName } from '../lib/quick-picker'

export type QuickPickerProps = {
  agents: AgentOption[]
  takenNames: string[]
  onCreate: (agentId: string, name: string) => void
  onCancel: () => void
}

/** The honest tier label: only a hooked agent (T1/T2) can be stopped before a write. */
function tierNote(tier: string): string {
  return tier === 'T1' || tier === 'T2' ? 'guarded' : 'advisory'
}

/**
 * ⌘T: pick an agent, name the session, Enter. Replaces two window.prompt boxes. Agents
 * turned off in Settings are left out; ones whose command is not installed are shown
 * but cannot be picked, so a missing CLI is visible rather than a failed start.
 */
export function QuickPicker({ agents, takenNames, onCreate, onCancel }: QuickPickerProps) {
  const usable = agents.filter((a) => a.enabled)
  const firstAvailable = Math.max(usable.findIndex((a) => a.available), 0)
  const [index, setIndex] = useState(firstAvailable)
  const selected = usable[index]
  const [name, setName] = useState(selected ? suggestSessionName(selected.id, takenNames) : '')
  const [nameTouched, setNameTouched] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const choose = (i: number): void => {
    setIndex(i)
    const agent = usable[i]
    if (agent && !nameTouched) setName(suggestSessionName(agent.id, takenNames))
  }
  const error = selected === undefined
    ? 'No agent is enabled — turn one on in Settings'
    : !selected.available
      ? `${selected.label} is not installed on this machine`
      : sessionNameError(name) ?? (takenNames.includes(name) ? 'A session with this name exists' : null)

  const submit = (): void => {
    if (error === null && selected) onCreate(selected.id, name)
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    const pressed = e.key
    if (pressed === 'Escape') {
      e.preventDefault()
      onCancel()
    } else if (pressed === 'ArrowDown') {
      e.preventDefault()
      choose(Math.min(index + 1, usable.length - 1))
    } else if (pressed === 'ArrowUp') {
      e.preventDefault()
      choose(Math.max(index - 1, 0))
    } else if (pressed === 'Enter') {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div class="cockpit-picker__backdrop" onClick={onCancel}>
      <div
        class="cockpit-picker"
        role="dialog"
        aria-label="New agent"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <h2 class="cockpit-picker__title">New agent</h2>
        <ul class="cockpit-picker__list" role="listbox" aria-label="Agent">
          {usable.map((agent, i) => (
            <li key={agent.id}>
              <button
                type="button"
                role="option"
                aria-selected={i === index}
                class={i === index ? 'cockpit-picker__agent is-selected' : 'cockpit-picker__agent'}
                onClick={() => choose(i)}
              >
                <span>{agent.label}</span>
                <span class="cockpit-muted">
                  {agent.available ? tierNote(agent.tier) : 'not installed'}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <label class="cockpit-picker__field">
          <span class="cockpit-muted">Session name</span>
          <input
            ref={inputRef}
            value={name}
            onInput={(e) => {
              setNameTouched(true)
              setName((e.target as HTMLInputElement).value)
            }}
            spellcheck={false}
          />
        </label>
        {error ? <p class="cockpit-error" role="alert">{error}</p> : null}
        <div class="cockpit-picker__actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="button" class="is-primary" disabled={error !== null} onClick={submit}>
            Create and start
          </button>
        </div>
      </div>
    </div>
  )
}
