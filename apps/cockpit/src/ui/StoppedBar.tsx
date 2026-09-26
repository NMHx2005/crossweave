import { useEffect, useRef, useState } from 'preact/hooks'

type StoppedBarProps = {
  sessionName: string
  focused: boolean
  /** Opens the session's shell again; resolves to an error sentence, or null. */
  onStart: () => Promise<string | null>
}

/**
 * Under a stopped session's terminal: its shell is closed, Enter opens a new one in
 * the same worktree. What runs in it is the user's to type — nothing is launched.
 */
export function StoppedBar({ sessionName, focused, onStart }: StoppedBarProps) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (focused) buttonRef.current?.focus()
  }, [focused])

  const start = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    const failure = await onStart()
    setBusy(false)
    if (failure !== null) setError(failure)
  }

  return (
    <div class="cockpit-launch" onMouseDown={(e) => e.stopPropagation()}>
      <div class="cockpit-launch__head">
        <span><strong>{sessionName}</strong>'s shell is closed.</span>
        <button ref={buttonRef} type="button" class="cockpit-launch__start" disabled={busy} onClick={() => void start()}>
          Open shell ⏎
        </button>
      </div>
      {error ? <p class="cockpit-launch__error" role="alert">{error}</p> : null}
    </div>
  )
}
