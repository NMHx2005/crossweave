/** @jsxImportSource preact */
import type { SessionPanel } from '../lib/session-panels'
import { ChevronIcon } from './icons'

/** A single pane is what the row itself opens, so only a session with two or more gets a list. */
const listed = (panels: readonly SessionPanel[]): boolean => panels.length >= 2

/** The count on the session row; it opens the list below without opening the session. */
export function SessionPanelChip({ id, sessionName, panels, expanded, onToggle }: {
  id: string
  sessionName: string
  panels: SessionPanel[]
  expanded: boolean
  onToggle: () => void
}) {
  if (!listed(panels)) return null
  return (
    <button type="button" class="cockpit-row-panels__chip" aria-expanded={expanded} aria-controls={id}
      aria-label={`${expanded ? 'Hide' : 'Show'} ${panels.length} panels for ${sessionName}`}
      title={`${panels.length} panels`}
      // The row is a role="button" that opens the session on click, Enter and Space.
      onClick={(event) => { event.stopPropagation(); onToggle() }}
      onKeyDown={(event) => event.stopPropagation()}>
      <span>{panels.length}</span>
      <ChevronIcon class="cockpit-row-panels__chevron" />
    </button>
  )
}

export function SessionPanelList({ id, sessionName, panels, expanded, onFocus }: {
  id: string
  sessionName: string
  panels: SessionPanel[]
  expanded: boolean
  onFocus: (panel: SessionPanel) => void
}) {
  if (!listed(panels)) return null
  return (
    <div id={id} class={`cockpit-row-panels${expanded ? ' is-open' : ''}`} inert={!expanded}>
      <ul class="cockpit-row-panels__list">
        {panels.map((panel) => (
          <li key={`${panel.tabId}:${panel.paneId}`}>
            <button type="button" class={`cockpit-row-panels__item${panel.active ? ' is-active' : ''}`} title={panel.title}
              aria-current={panel.active ? 'true' : undefined}
              aria-label={`Focus ${panel.title ?? panel.label} panel for ${sessionName}`}
              onClick={(event) => { event.stopPropagation(); onFocus(panel) }}>
              {panel.label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
