import type { ListedSession } from '../host/cockpit-api'
import { XtermPane } from './XtermPane'

export type StageStatus = 'loading' | 'ready' | 'empty' | 'error'

export type StageProps = {
  sessions: ListedSession[]
  focusedId: string | null
  status: StageStatus
  error: string | null
  /** Bumped after daemon.gone reconnect so unchanged session ids still remount panes. */
  paneAttachKey?: number
  onFocus?: (sessionId: string) => void
}

const MAX_PANES = 4

export function pickPaneSessions(
  sessions: ListedSession[],
  focusedId: string | null,
  max = MAX_PANES,
): ListedSession[] {
  if (sessions.length <= max) return sessions
  const focused = focusedId ? sessions.find((session) => session.id === focusedId) : undefined
  const rest = sessions.filter((session) => session.id !== focusedId)
  if (focused) return [focused, ...rest.slice(0, max - 1)]
  return rest.slice(0, max)
}

export function Stage({ sessions, focusedId, status, error, paneAttachKey = 0, onFocus }: StageProps) {
  const panes = pickPaneSessions(sessions, focusedId)
  const focused = sessions.find((session) => session.id === focusedId) ?? null
  const showPanes = status === 'ready' || (status === 'error' && panes.length > 0)

  return (
    <main class="cockpit-stage" aria-label="Stage">
      <header class="cockpit-stage__header">
        <h2>Stage</h2>
        {focused ? (
          <p class="cockpit-muted">{focused.name}</p>
        ) : (
          <p class="cockpit-muted">Select a session in the rail.</p>
        )}
        {error && showPanes ? (
          <p class="cockpit-error" role="alert">
            {error}
          </p>
        ) : null}
      </header>
      {status === 'loading' && <p class="cockpit-placeholder">Connecting to cwd…</p>}
      {status === 'error' && !showPanes && (
        <p class="cockpit-placeholder">Workspace error: {error}</p>
      )}
      {status === 'empty' && (
        <p class="cockpit-placeholder">
          No sessions. Use <strong>New</strong> or <code>cw session new</code> /{' '}
          <code>cw session start</code>.
        </p>
      )}
      {showPanes && panes.length > 0 && (
        <div class="cockpit-stage__grid" data-count={String(panes.length)}>
          {panes.map((session) => (
            <div
              key={session.id}
              class={
                session.id === focusedId
                  ? 'cockpit-stage__pane is-focused'
                  : 'cockpit-stage__pane'
              }
              onClick={() => onFocus?.(session.id)}
            >
              <XtermPane
                key={`${session.id}:${paneAttachKey}`}
                sessionId={session.id}
                focused={session.id === focusedId}
              />
            </div>
          ))}
        </div>
      )}
    </main>
  )
}
