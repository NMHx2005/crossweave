import type { ListedSession } from '../host/cockpit-api'
import type { AttentionKind } from '../lib/attention'

const BADGE_LABEL: Record<AttentionKind, string> = {
  blocked: 'blocked',
  needs_you: 'needs you',
  conflict: 'conflict',
  ready: 'ready',
  unknown: 'unknown',
  working: 'working',
}

export type AgentRailProps = {
  sessions: ListedSession[]
  focusedId: string | null
  attentionById: Record<string, AttentionKind>
  onFocus: (sessionId: string) => void
  onNew: () => void
  onStop: () => void
  onKill: () => void
}

export function AgentRail({
  sessions,
  focusedId,
  attentionById,
  onFocus,
  onNew,
  onStop,
  onKill,
}: AgentRailProps) {
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
        <button type="button" onClick={onStop} disabled={!focusedId}>
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
                  </span>
                  <span class={`cockpit-rail__badge cockpit-rail__badge--${attention}`}>
                    {BADGE_LABEL[attention]}
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
