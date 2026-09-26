import { useEffect, useRef, useState } from 'preact/hooks'

export type LaunchLineProps = {
  sessionName: string
  /** The line to start from: the agent's command plus this session's last flags. */
  initial: string
  /** Earlier lines for this agent, newest first (↑ walks back through them). */
  history: string[]
  focused: boolean
  /** Starts the session with this line; resolves to an error sentence or null. */
  onLaunch: (line: string) => Promise<string | null>
}

/**
 * A stopped session's prompt: edit the command, Enter starts it. Creating a session
 * never starts it, so this is where the user adds `--model …` or a bypass flag — the
 * agent still starts through crossweave, keeping its hook, sandbox and resume.
 */
export function LaunchLine({ sessionName, initial, history, focused, onLaunch }: LaunchLineProps) {
  const [line, setLine] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // -1 = the line being edited; 0.. = history[i].
  const [recall, setRecall] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { setLine(initial) }, [initial])
  useEffect(() => {
    if (focused) inputRef.current?.focus()
  }, [focused])

  const submit = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    const failure = await onLaunch(line)
    setBusy(false)
    if (failure !== null) setError(failure)
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    // A composing IME (Vietnamese Telex, …) owns Enter and the arrows until it commits.
    if (e.isComposing) return
    if (e.key === 'Enter') {
      e.preventDefault()
      void submit()
    } else if (e.key === 'ArrowUp' && history.length > 0) {
      e.preventDefault()
      const next = Math.min(recall + 1, history.length - 1)
      setRecall(next)
      setLine(history[next] ?? line)
    } else if (e.key === 'ArrowDown' && recall >= 0) {
      e.preventDefault()
      const next = recall - 1
      setRecall(next)
      setLine(next < 0 ? initial : history[next] ?? initial)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setRecall(-1)
      setLine(initial)
      setError(null)
    }
  }

  return (
    <div class="cockpit-launch" onMouseDown={(e) => e.stopPropagation()}>
      <div class="cockpit-launch__head">
        <span><strong>{sessionName}</strong> is not running.</span>
        <span class="cockpit-muted">Enter: start · ↑ earlier commands · Esc: reset</span>
      </div>
      <label class="cockpit-launch__line">
        <span class="cockpit-launch__prompt" aria-hidden="true">$</span>
        <input
          ref={inputRef}
          aria-label={`Command to start ${sessionName}`}
          value={line}
          spellcheck={false}
          disabled={busy}
          onInput={(e) => {
            setRecall(-1)
            setLine((e.target as HTMLInputElement).value)
          }}
          onKeyDown={onKeyDown}
        />
      </label>
      {error ? <p class="cockpit-launch__error" role="alert">{error}</p> : null}
    </div>
  )
}
