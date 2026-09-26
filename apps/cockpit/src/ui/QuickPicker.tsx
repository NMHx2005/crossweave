import { useEffect, useRef, useState } from 'preact/hooks'
import { sessionNameError, suggestSessionName } from '../lib/quick-picker'

export type NewSessionOptions = {
  /** Branch to start the worktree from; HEAD when undefined. */
  base?: string
  /** False: share the main checkout instead of an isolated worktree. */
  worktree: boolean
}

export type QuickPickerProps = {
  takenNames: string[]
  /** Branches a worktree can start from, most recent first. */
  branches: string[]
  onCreate: (name: string, options: NewSessionOptions) => void
  onCancel: () => void
}

/**
 * ⌘T: name a session, choose where its worktree starts, Enter. It opens as a shell in
 * that worktree; what runs there (`cx`, `claude …`) is the user's to type.
 */
export function QuickPicker({ takenNames, branches, onCreate, onCancel }: QuickPickerProps) {
  const [name, setName] = useState(() => suggestSessionName('session', takenNames))
  const [base, setBase] = useState('')
  const [isolated, setIsolated] = useState(true)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const error = sessionNameError(name) ?? (takenNames.includes(name) ? 'A session with this name exists' : null)

  const submit = (): void => {
    if (error === null) onCreate(name, { worktree: isolated, ...(isolated && base !== '' ? { base } : {}) })
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    // A composing IME (Vietnamese Telex, …) owns Enter until it commits.
    if (e.isComposing) return
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div class="cockpit-picker__backdrop" onClick={onCancel}>
      <div
        class="cockpit-picker"
        role="dialog"
        aria-label="New session"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <h2 class="cockpit-picker__title">New session</h2>
        <label class="cockpit-picker__field">
          <span class="cockpit-muted">Name</span>
          <input
            ref={inputRef}
            value={name}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
            spellcheck={false}
          />
        </label>
        <label class="cockpit-picker__field">
          <span class="cockpit-muted">Start from</span>
          <select value={base} disabled={!isolated} onChange={(e) => setBase((e.target as HTMLSelectElement).value)}>
            <option value="">current HEAD</option>
            {branches.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </label>
        <label class="cockpit-picker__check">
          <input type="checkbox" checked={isolated} onChange={(e) => setIsolated((e.target as HTMLInputElement).checked)} />
          <span>Own worktree (isolated). Off: works in the main checkout, shared with you.</span>
        </label>
        {error ? <p class="cockpit-error" role="alert">{error}</p> : null}
        <div class="cockpit-picker__actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="button" class="is-primary" disabled={error !== null} onClick={submit}>
            Create and open shell
          </button>
        </div>
      </div>
    </div>
  )
}
