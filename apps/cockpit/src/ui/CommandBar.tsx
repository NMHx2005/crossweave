import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { COMMANDS, completions, parseCommand, type Command, type CommandContext } from '../lib/commands'

type CommandBarProps = {
  context: CommandContext
  /** Earlier command lines, newest first. */
  history: string[]
  /** Runs a parsed command; resolves to an error sentence, or null when done. */
  onRun: (command: Command, line: string) => Promise<string | null>
  onClose: () => void
}

/**
 * ⌘K: `cw`'s verbs, typed. Tab completes the word under the cursor, ↑/↓ walk the
 * suggestions (or, on an empty line, earlier commands), Enter runs, Esc closes.
 */
export function CommandBar({ context, history, onRun, onClose }: CommandBarProps) {
  const [line, setLine] = useState('')
  const [selected, setSelected] = useState(0)
  const [recall, setRecall] = useState(-1)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const showHelp = line.trim() === 'help'
  const suggestions = useMemo(() => (showHelp ? [] : completions(line, context)), [line, context, showHelp])

  const accept = (value: string): void => {
    setLine(value)
    setSelected(0)
    setError(null)
    inputRef.current?.focus()
  }

  const submit = async (): Promise<void> => {
    if (busy) return
    const parsed = parseCommand(line, context)
    if (!parsed.ok) {
      setError(parsed.error)
      return
    }
    if (parsed.command.kind === 'help') {
      setError(null)
      return
    }
    setBusy(true)
    const failure = await onRun(parsed.command, line.trim())
    setBusy(false)
    if (failure === null) onClose()
    else setError(failure)
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    // A composing IME (Vietnamese Telex, …) owns these keys until it commits.
    if (e.isComposing) return
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      void submit()
    } else if (e.key === 'Tab') {
      const pick = suggestions[selected]
      if (pick) {
        e.preventDefault()
        accept(pick.value)
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (suggestions.length > 0) setSelected((i) => Math.min(i + 1, suggestions.length - 1))
      else if (recall >= 0) {
        const next = recall - 1
        setRecall(next)
        setLine(next < 0 ? '' : history[next] ?? '')
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if ((line === '' || recall >= 0) && history.length > 0) {
        const next = Math.min(recall + 1, history.length - 1)
        setRecall(next)
        setLine(history[next] ?? '')
      } else {
        setSelected((i) => Math.max(i - 1, 0))
      }
    }
  }

  return (
    <div class="cockpit-picker__backdrop cockpit-command__backdrop" onClick={onClose}>
      <div class="cockpit-picker cockpit-command" role="dialog" aria-label="Command" onClick={(e) => e.stopPropagation()}>
        <label class="cockpit-launch__line">
          <span class="cockpit-launch__prompt" aria-hidden="true">›</span>
          <input
            ref={inputRef}
            aria-label="Command"
            placeholder="new api claude -- --model opus · start · land · diff · help"
            value={line}
            spellcheck={false}
            disabled={busy}
            onInput={(e) => {
              setRecall(-1)
              setSelected(0)
              setError(null)
              setLine((e.target as HTMLInputElement).value)
            }}
            onKeyDown={onKeyDown}
          />
        </label>
        {error ? <p class="cockpit-launch__error" role="alert">{error}</p> : null}
        {showHelp || line.trim() === '' ? (
          <ul class="cockpit-command__list" aria-label="Commands">
            {COMMANDS.map((c) => (
              <li key={c.name}>
                <button type="button" onClick={() => accept(`${c.name} `)}>
                  <code>{c.usage}</code>
                  <span class="cockpit-muted">{c.summary}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : suggestions.length > 0 ? (
          <ul class="cockpit-command__list" role="listbox" aria-label="Suggestions">
            {suggestions.map((s, i) => (
              <li key={s.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === selected}
                  class={i === selected ? 'is-selected' : ''}
                  onClick={() => accept(s.value)}
                >
                  <code>{s.label}</code>
                  <span class="cockpit-muted">{s.detail}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <p class="cockpit-muted cockpit-command__hint">Tab: complete · ↑↓: choose / history · Enter: run · Esc: close</p>
      </div>
    </div>
  )
}
