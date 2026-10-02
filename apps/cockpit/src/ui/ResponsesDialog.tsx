import { relativeTime } from '../lib/rail'
import type { ResponseRow } from '../lib/responses'

/**
 * The sessions the last prompt went to, each with its rail state, its agent's latest
 * words and its tests chip; a click jumps to that session's pane. Pure, so it is
 * walk-tested; there is no persistence — the view lives for one working stretch.
 */
export function ResponsesView({ rows, now, onJump }: {
  rows: readonly ResponseRow[]
  now: number
  onJump: (id: string) => void
}) {
  if (rows.length === 0) {
    return <p class="cockpit-placeholder">Nothing sent yet — send a prompt (⌘⇧P) and the sessions it went to appear here.</p>
  }
  return (
    <ul class="cockpit-responses" aria-label="Sessions the last prompt went to">
      {rows.map((r) => {
        const ago = relativeTime(r.lastActivityAt, now)
        return (
          <li key={r.id} class="cockpit-responses__row">
            <button type="button" class="cockpit-responses__open" onClick={() => onJump(r.id)}>
              <span class={`cockpit-responses__state is-${r.state}`} title={r.stateLabel}>{r.stateLabel}</span>
              <span class="cockpit-responses__name">{r.name}</span>
              {ago !== undefined ? <span class="cockpit-muted">{ago}</span> : null}
              {r.check !== undefined ? <span class={`cockpit-responses__check is-${r.check.tone}`} title={r.check.title}>{r.check.label}</span> : null}
              {r.latestWords !== undefined ? <span class="cockpit-responses__words">{r.latestWords}</span> : null}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/** ⌘⇧R: the Responses view as a dialog, over whatever the project shows. */
export function ResponsesDialog({ rows, now, onJump, onClose }: {
  rows: readonly ResponseRow[]
  now: number
  onJump: (id: string) => void
  onClose: () => void
}) {
  return (
    <div class="cockpit-picker__backdrop" onClick={onClose}>
      <div class="cockpit-picker cockpit-responses-dialog" role="dialog" aria-label="Responses"
        onClick={(ev) => ev.stopPropagation()} onKeyDown={(ev) => { if (ev.code === 'Escape') onClose() }}>
        <h2 class="cockpit-picker__title">Responses</h2>
        <ResponsesView rows={rows} now={now} onJump={onJump} />
        <div class="cockpit-picker__actions">
          <button type="button" class="cockpit-btn cockpit-btn--primary" autoFocus onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
