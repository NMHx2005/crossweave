import type { ListedSession } from '../host/cockpit-api'
import { formatRailMeta, isSessionRunning } from '../lib/sessions'
import { attentionLabel, type AttentionKind } from '../lib/attention'

export type AgentRailProps = {
  sessions: ListedSession[]
  focusedId: string | null
  attentionById: Record<string, AttentionKind>
  onFocus: (sessionId: string) => void
  onNew: () => void
  onStart: () => void
  onStop: () => void
  onKill: () => void
}

export function AgentRail({
  sessions,
  focusedId,
  attentionById,
  onFocus,
  onNew,
  onStart,
  onStop,
  onKill,
}: AgentRailProps) {
  const focusedRunning =
    focusedId !== null && isSessionRunning(sessions.find((session) => session.id === focusedId) ?? {})
  return (
    <aside class="cockpit-rail" aria-label="Agent rail">
      <header class="cockpit-rail__header">
        <h1>Cockpit</h1>
        <p class="cockpit-muted">Agent rail</p>
      </header>
      <div class="cockpit-rail__actions">
        <button type="button" onClick={onNew}>
          New
        </button>
        <button
          type="button"
          onClick={onStart}
          disabled={!focusedId || focusedRunning}
          title={focusedId && !focusedRunning ? 'Start the agent for the focused session' : undefined}
        >
          Start
        </button>
        <button type="button" onClick={onStop} disabled={!focusedId || !focusedRunning}>
          Stop
        </button>
        <button type="button" onClick={onKill} disabled={!focusedId}>
          Kill
        </button>
      </div>
      {sessions.length === 0 ? (
        <p class="cockpit-placeholder">Sessions will appear here.</p>
      ) : (
        <ul class="cockpit-rail__list">
          {sessions.map((session) => {
            const attention = attentionById[session.id] ?? 'working'
            const focused = session.id === focusedId
            const meta = formatRailMeta(session)
            return (
              <li key={session.id}>
                <button
                  type="button"
                  class={focused ? 'cockpit-rail__item is-focused' : 'cockpit-rail__item'}
                  aria-current={focused ? 'true' : undefined}
                  onClick={() => onFocus(session.id)}
                >
                  <span class="cockpit-rail__meta">
                    <span class="cockpit-rail__name">{session.name}</span>
                    {session.agentKind ? (
                      <span class="cockpit-muted">{session.agentKind}</span>
                    ) : null}
                    {meta ? <span class="cockpit-muted">{meta}</span> : null}
                  </span>
                  <span class={`cockpit-rail__badge cockpit-rail__badge--${attention}`}>
                    {attentionLabel(attention, session.status ?? '')}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </aside>
  )
}
