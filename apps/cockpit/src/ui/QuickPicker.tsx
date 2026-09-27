import { useEffect, useRef, useState } from 'preact/hooks'
import type { LauncherOption } from '../host/cockpit-api'
import { sessionNameError, suggestSessionName } from '../lib/quick-picker'
import { AgentMark } from './icons'

export type NewSessionOptions = {
  /** Branch to start the worktree from; HEAD when undefined. */
  base?: string
  /** False: share the main checkout instead of an isolated worktree. */
  worktree: boolean
}

export type NewSessionRequest = {
  projectRoot: string
  name: string
  options: NewSessionOptions
  /** A launcher id from Settings, or 'terminal' for a plain shell. */
  launcher: string
}

export type QuickPickerProps = {
  /** Every open project; `activeRoot` is preselected. */
  projects: Array<{ projectRoot: string; name: string }>
  activeRoot: string
  takenNames: string[]
  /** Branches of the active project a worktree can start from, most recent first. */
  branches: string[]
  launchers: LauncherOption[]
  /** The launcher chosen last time, preselected when it is still usable. */
  lastLauncher: string | undefined
  onCreate: (request: NewSessionRequest) => void
  onCancel: () => void
}

type Choice = { id: string; label: string; detail: string; usable: boolean; agent: string | null }

/**
 * ⌘T: which project, what to start (a plain Terminal, or an agent CLI from Settings —
 * the ones this machine does not have are shown but cannot be picked), a name, and
 * where the worktree starts. The shell opens in the session's worktree at once.
 */
export function QuickPicker(props: QuickPickerProps) {
  const { projects, activeRoot, takenNames, branches, launchers } = props
  const choices: Choice[] = [
    { id: 'terminal', label: 'Terminal', detail: 'a plain shell', usable: true, agent: null },
    ...launchers.filter((l) => l.enabled).map((l) => ({
      id: l.id,
      label: l.label,
      detail: l.available ? l.command : 'not installed',
      usable: l.available,
      agent: l.id,
    })),
  ]
  const initial = Math.max(0, choices.findIndex((c) => c.id === props.lastLauncher && c.usable))
  const [index, setIndex] = useState(initial)
  const chosen = choices[index] ?? choices[0]!
  const prefix = (id: string): string => (id === 'terminal' ? 'shell' : id)
  const [name, setName] = useState(() => suggestSessionName(prefix(chosen.id), takenNames))
  const [nameTouched, setNameTouched] = useState(false)
  const [projectRoot, setProjectRoot] = useState(activeRoot)
  const [base, setBase] = useState('')
  const [isolated, setIsolated] = useState(true)
  const inputRef = useRef<HTMLInputElement>(null)
  const otherProject = projectRoot !== activeRoot

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const choose = (i: number): void => {
    const next = choices[i]
    if (!next || !next.usable) return
    setIndex(i)
    if (!nameTouched) setName(suggestSessionName(prefix(next.id), takenNames))
  }

  // Names are checked against the active project only; another project's daemon
  // answers for its own names when the session is created there.
  const error = sessionNameError(name) ?? (!otherProject && takenNames.includes(name) ? 'A session with this name exists' : null)

  const submit = (): void => {
    if (error !== null || !chosen.usable) return
    props.onCreate({
      projectRoot,
      name,
      launcher: chosen.id,
      options: { worktree: isolated, ...(isolated && base !== '' && !otherProject ? { base } : {}) },
    })
  }

  const move = (delta: number): void => {
    for (let i = index + delta; i >= 0 && i < choices.length; i += delta) {
      if (choices[i]?.usable) {
        choose(i)
        return
      }
    }
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    // A composing IME (Vietnamese Telex, …) owns these keys until it commits.
    if (e.isComposing) return
    if (e.key === 'Escape') {
      e.preventDefault()
      props.onCancel()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      submit()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      move(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      move(-1)
    }
  }

  return (
    <div class="cockpit-picker__backdrop" onClick={props.onCancel}>
      <div class="cockpit-picker cockpit-picker--new" role="dialog" aria-label="New session" onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <h2 class="cockpit-picker__title">New session</h2>

        {projects.length > 1 ? (
          <label class="cockpit-picker__field">
            <span class="cockpit-muted">Project</span>
            <select value={projectRoot} onChange={(e) => setProjectRoot((e.target as HTMLSelectElement).value)}>
              {projects.map((p) => <option key={p.projectRoot} value={p.projectRoot}>{p.name}</option>)}
            </select>
          </label>
        ) : null}

        <ul class="cockpit-picker__list" role="listbox" aria-label="Start with">
          {choices.map((c, i) => (
            <li key={c.id}>
              <button
                type="button"
                role="option"
                aria-selected={i === index}
                aria-disabled={!c.usable}
                disabled={!c.usable}
                class={`cockpit-picker__agent${i === index ? ' is-selected' : ''}`}
                onClick={() => choose(i)}
                title={c.usable ? c.detail : `${c.label} is not installed on this machine — edit its command in Settings (⌘,)`}
              >
                <AgentMark agent={c.agent} />
                <span class="cockpit-picker__agent-label">{c.label}</span>
                <span class="cockpit-muted cockpit-picker__agent-detail">{c.detail}</span>
              </button>
            </li>
          ))}
        </ul>

        <label class="cockpit-picker__field">
          <span class="cockpit-muted">Name</span>
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
        <label class="cockpit-picker__field">
          <span class="cockpit-muted">Start from</span>
          <select value={base} disabled={!isolated || otherProject} onChange={(e) => setBase((e.target as HTMLSelectElement).value)}>
            <option value="">current HEAD</option>
            {otherProject ? null : branches.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </label>
        <label class="cockpit-picker__check">
          <input type="checkbox" checked={isolated} onChange={(e) => setIsolated((e.target as HTMLInputElement).checked)} />
          <span>Own worktree (isolated). Off: works in the project folder itself, shared with you.</span>
        </label>
        {error ? <p class="cockpit-error" role="alert">{error}</p> : null}
        <div class="cockpit-picker__actions">
          <button type="button" onClick={props.onCancel}>Cancel</button>
          <button type="button" class="is-primary" disabled={error !== null || !chosen.usable} onClick={submit}>
            {chosen.id === 'terminal' ? 'Open terminal' : `Start ${chosen.label}`}
          </button>
        </div>
      </div>
    </div>
  )
}
