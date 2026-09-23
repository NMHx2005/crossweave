import { useState } from 'preact/hooks'
import type { ActivityItem } from '../../../../src/domain/activity.js'
import type { ListedSession } from '../host/cockpit-api'
import { formatRailMeta, isSessionRunning } from '../lib/sessions'
import { attentionLabel, type AttentionKind } from '../lib/attention'
import { ACTIVITY_BADGE, ACTIVITY_LABEL } from '../lib/activity'

export type AgentRailProps = {
  sessions: ListedSession[]
  focusedId: string | null
  attentionById: Record<string, AttentionKind>
  activity: ActivityItem[]
  onFocus: (sessionId: string) => void
  onSelectActivity: (sessionName: string) => void
  onNew: () => void
  onStart: () => void
  onStop: () => void
  onKill: () => void
}

/** Deck's "Recent activity" shows the latest five unread; "View all" is the history. */
const UNREAD_SHOWN = 5

export function AgentRail({
  sessions,
  focusedId,
  attentionById,
  activity,
  onFocus,
  onSelectActivity,
  onNew,
  onStart,
  onStop,
  onKill,
}: AgentRailProps) {
  const [showAll, setShowAll] = useState(false)
  const focusedRunning =
    focusedId !== null && isSessionRunning(sessions.find((session) => session.id === focusedId) ?? {})
  const unread = activity.filter((item) => !item.read)
  const items = showAll ? activity : unread.slice(0, UNREAD_SHOWN)
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
      {/* What happened while you were looking elsewhere. Selecting one is what clears it —
          the count and the panes cannot disagree, because both read the same focused id. */}
      <section class="cockpit-rail__activity" aria-label="Recent activity">
        <div class="cockpit-rail__activity-head">
          <span class="cockpit-rail__activity-title">Recent</span>
          {unread.length > 0 ? (
            <span class="cockpit-rail__count">{unread.length} new</span>
          ) : null}
          {activity.length > 0 ? (
            <button
              type="button"
              class="cockpit-rail__link"
              onClick={() => setShowAll((shown) => !shown)}
            >
              {showAll ? 'Hide' : 'View all'}
            </button>
          ) : null}
        </div>
        {items.length === 0 ? (
          <p class="cockpit-muted">Nothing needs you.</p>
        ) : (
          <ul class="cockpit-rail__activity-list">
            {items.map((item, index) => (
              <li key={`${item.session}:${item.at}:${String(index)}`}>
                <button
                  type="button"
                  class={
                    item.read
                      ? 'cockpit-rail__activity-item is-read'
                      : 'cockpit-rail__activity-item'
                  }
                  onClick={() => onSelectActivity(item.session)}
                >
                  <span class="cockpit-rail__name">{item.session}</span>
                  <span
                    class={`cockpit-rail__badge cockpit-rail__badge--${ACTIVITY_BADGE[item.kind]}`}
                  >
                    {ACTIVITY_LABEL[item.kind]}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
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
