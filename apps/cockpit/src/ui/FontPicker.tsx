import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { useDismiss } from './useDismiss'

export type InstalledFont = { family: string; mono: boolean }

type Row = { family: string | undefined; label: string; group?: string }

/**
 * A font chooser over the fonts installed on this Mac: each name is drawn in its own
 * face, a search box narrows the list, the well-known good ones float to the top, and
 * the first row puts the cockpit's own font back. `mono` lists fixed-pitch fonts first
 * (the code and terminal fonts).
 */
export function FontPicker({ label, value, fonts, suggestions, mono = false, defaultLabel, onChange }: {
  label: string
  value: string | undefined
  fonts: InstalledFont[]
  /** Offered first when installed, in this order. */
  suggestions: readonly string[]
  mono?: boolean
  /** What "no choice" means here, e.g. "System (SF Pro)". */
  defaultLabel: string
  onChange: (family: string | undefined) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const boxRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, close, boxRef)

  const rows = useMemo((): Row[] => {
    const q = query.trim().toLowerCase()
    const matches = (f: string): boolean => q === '' || f.toLowerCase().includes(q)
    const installed = new Set(fonts.map((f) => f.family))
    const suggested = suggestions.filter((s) => installed.has(s) && matches(s))
    const rest = fonts
      .filter((f) => !suggested.includes(f.family) && matches(f.family))
      .sort((a, b) => (mono ? Number(b.mono) - Number(a.mono) : 0))
    const out: Row[] = []
    if (q === '' || defaultLabel.toLowerCase().includes(q)) out.push({ family: undefined, label: defaultLabel })
    suggested.forEach((family, i) => out.push({ family, label: family, ...(i === 0 ? { group: 'Suggested' } : {}) }))
    rest.forEach((f, i) => out.push({ family: f.family, label: f.family, ...(i === 0 ? { group: mono ? 'Installed — monospace first' : 'Installed' } : {}) }))
    return out
  }, [fonts, suggestions, query, mono, defaultLabel])

  const toggle = (): void => {
    if (open) {
      setOpen(false)
      return
    }
    // Opening starts from the whole list, on the font in use. `rows` is only the whole
    // list when no search is left over from last time; otherwise start at the top.
    const at = query === '' ? rows.findIndex((r) => r.family === value) : -1
    setQuery('')
    setActive(Math.max(0, at))
    setOpen(true)
  }

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  const pick = (row: Row | undefined): void => {
    if (!row) return
    onChange(row.family)
    setOpen(false)
  }

  return (
    <div class="cockpit-fontpick" ref={boxRef}>
      <button type="button" class="cockpit-fontpick__button" aria-haspopup="listbox" aria-expanded={open} aria-label={`${label}: ${value ?? defaultLabel}`}
        style={value ? { fontFamily: `"${value}"` } : undefined}
        onClick={toggle}>
        <span>{value ?? defaultLabel}</span>
      </button>
      {open ? (
        <div class="cockpit-fontpick__popover">
          <input
            autoFocus
            value={query}
            placeholder={fonts.length === 0 ? 'Reading installed fonts…' : `Search ${fonts.length} fonts`}
            aria-label={`Search fonts for ${label}`}
            spellcheck={false}
            onInput={(e) => { setQuery((e.target as HTMLInputElement).value); setActive(0) }}
            onKeyDown={(e) => {
              if (e.isComposing) return
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(rows.length - 1, i + 1)) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)) }
              else if (e.key === 'Enter') { e.preventDefault(); pick(rows[active]) }
              else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false) }
            }}
          />
          <ul class="cockpit-fontpick__list" role="listbox" aria-label={label} ref={listRef}>
            {rows.length === 0 ? <li class="cockpit-muted cockpit-fontpick__empty">No font matches.</li> : null}
            {rows.map((row, i) => (
              <li key={row.family ?? '(default)'}>
                {row.group ? <div class="cockpit-fontpick__group">{row.group}</div> : null}
                <button type="button" role="option" data-index={i} aria-selected={row.family === value}
                  class={`cockpit-fontpick__option${i === active ? ' is-active' : ''}`}
                  style={row.family ? { fontFamily: `"${row.family}"` } : undefined}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(row)}>
                  {row.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
