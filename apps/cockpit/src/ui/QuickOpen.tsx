import { useEffect, useRef, useState } from 'preact/hooks'
import { fuzzyFilter } from '../lib/surfaces'

const SHOWN = 50

/** ⌘P: find a file in the focused session's worktree and open it in an editor pane. */
export function QuickOpen({ sessionName, files, onOpen, onCancel }: {
  sessionName: string
  files: string[]
  onOpen: (path: string) => void
  onCancel: () => void
}) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const matches = fuzzyFilter(files, query, SHOWN)

  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => { setIndex(0) }, [query])

  const onKeyDown = (e: KeyboardEvent): void => {
    // A composing IME (Vietnamese Telex, …) owns Enter and the arrows until it commits.
    if (e.isComposing) return
    const pressed = e.key
    if (pressed === 'Escape') { e.preventDefault(); onCancel() }
    else if (pressed === 'ArrowDown') { e.preventDefault(); setIndex(Math.min(index + 1, matches.length - 1)) }
    else if (pressed === 'ArrowUp') { e.preventDefault(); setIndex(Math.max(index - 1, 0)) }
    else if (pressed === 'Enter') {
      e.preventDefault()
      const pick = matches[index]
      if (pick !== undefined) onOpen(pick)
    }
  }

  return (
    <div class="cockpit-picker__backdrop" onClick={onCancel}>
      <div class="cockpit-picker" role="dialog" aria-label="Open file" onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <h2 class="cockpit-picker__title">Open file in {sessionName}</h2>
        <label class="cockpit-picker__field">
          <input
            ref={inputRef}
            value={query}
            placeholder="Type to search the worktree"
            spellcheck={false}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          />
        </label>
        <ul class="cockpit-picker__list cockpit-quickopen__list" role="listbox" aria-label="Files">
          {matches.length === 0 ? <li class="cockpit-muted">No matching files.</li> : null}
          {matches.map((file, i) => (
            <li key={file}>
              <button
                type="button"
                role="option"
                aria-selected={i === index}
                class={i === index ? 'cockpit-picker__agent is-selected' : 'cockpit-picker__agent'}
                onClick={() => onOpen(file)}
              >
                <span>{file.split('/').pop()}</span>
                <span class="cockpit-muted">{file}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
