import type { ListedSession, TerminalInfo } from '../host/cockpit-api'
import { sessionSource, terminalSource } from '../lib/pane-source'
import { XtermPane } from './XtermPane'
import { pickPanes } from '../lib/panes'

export type StageStatus = 'loading' | 'ready' | 'empty' | 'error'

export type StageProps = {
  sessions: ListedSession[]
  focusedId: string | null
  status: StageStatus
  error: string | null
  /** Bumped after daemon.gone reconnect so unchanged session ids still remount panes. */
  /** Global re-attach epoch — daemon.gone replaces every pane's connection. */
  paneAttachEpoch?: number
  /** Per-session re-attach counters, so a Start re-keys only the pane that asked. */
  paneAttachBumps?: Record<string, number>
  onFocus?: (sessionId: string) => void
  /** Open Terminal panes (shells in a session's worktree). */
  terminals?: TerminalInfo[]
  focusedTerminalId?: string | null
  onFocusTerminal?: (terminalId: string) => void
  onCloseTerminal?: (terminalId: string) => void
}

export function Stage({
  sessions,
  focusedId,
  status,
  error,
  paneAttachEpoch = 0,
  paneAttachBumps = {},
  onFocus,
  terminals = [],
  focusedTerminalId = null,
  onFocusTerminal,
  onCloseTerminal,
}: StageProps) {
  const panes = pickPanes(sessions, terminals, focusedId)
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
          No sessions. Use <strong>New</strong>, or <code>cw session new</code> then{' '}
          <code>cw session start &lt;name&gt;</code> or <code>cw session attach &lt;name&gt;</code> to start it.
        </p>
      )}
      {showPanes && panes.length > 0 && (
        <div class="cockpit-stage__grid" data-count={String(panes.length)}>
          {panes.map((pane) => {
            if (pane.kind === 'terminal') {
              const { terminal } = pane
              const isFocused = terminal.terminalId === focusedTerminalId
              return (
                <div
                  key={`terminal:${terminal.terminalId}`}
                  class={isFocused ? 'cockpit-stage__pane cockpit-stage__pane--terminal is-focused' : 'cockpit-stage__pane cockpit-stage__pane--terminal'}
                  onClick={() => onFocusTerminal?.(terminal.terminalId)}
                >
                  <div class="cockpit-pane-bar">
                    {/* Honest about coverage: a shell has no hook, so Radar cannot stop its writes. */}
                    <span>{terminal.sessionName} · shell</span>
                    <span class="cockpit-pane-bar__note" title="Writes typed here are not checked by Collision Radar">not guarded</span>
                    <button
                      type="button"
                      class="cockpit-pane-bar__close"
                      aria-label={`Close ${terminal.sessionName} shell`}
                      onClick={(e) => {
                        e.stopPropagation()
                        onCloseTerminal?.(terminal.terminalId)
                      }}
                    >
                      ×
                    </button>
                  </div>
                  <XtermPane
                    key={`terminal:${terminal.terminalId}:${paneAttachEpoch}`}
                    source={terminalSource(terminal.terminalId, terminal.sessionId)}
                    focused={isFocused}
                  />
                </div>
              )
            }
            const { session } = pane
            return (
              <div
                key={session.id}
                class={
                  session.id === focusedId && focusedTerminalId === null
                    ? 'cockpit-stage__pane is-focused'
                    : 'cockpit-stage__pane'
                }
                onClick={() => onFocus?.(session.id)}
              >
                <XtermPane
                  key={`${session.id}:${paneAttachEpoch}:${paneAttachBumps[session.id] ?? 0}`}
                  source={sessionSource(session.id)}
                  focused={session.id === focusedId && focusedTerminalId === null}
                />
              </div>
            )
          })}
        </div>
      )}
    </main>
  )
}
