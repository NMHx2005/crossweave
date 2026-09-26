import { useCallback, useRef, useState } from 'preact/hooks'
import { useDismiss } from './useDismiss'
import type { ActivityItem } from '../../../../src/domain/activity.js'
import type { ListedSession } from '../host/cockpit-api'
import { tierCoverageSentence } from '../../../../src/adapters/coverage.js'
import { formatRailMeta, isSessionRunning } from '../lib/sessions'
import { attentionLabel, type AttentionKind } from '../lib/attention'
import { ACTIVITY_BADGE, ACTIVITY_LABEL } from '../lib/activity'
import { SESSION_COLORS, type SessionColor } from '../lib/colors'

export type AgentRailProps = {
  sessions: ListedSession[]
  focusedId: string | null
  attentionById: Record<string, AttentionKind>
  activity: ActivityItem[]
  onFocus: (sessionId: string) => void
  onSelectActivity: (sessionName: string) => void
  /** The workspace line at the top: name, base branch, what runs, spend. */
  header: { title: string; meta: string }
  /** Commands first: the action buttons show only when the user turned them on. */
  showButtons: boolean
  onCommandBar: () => void
  onChanges: () => void
  onNew: () => void
  onStart: () => void
  onStop: () => void
  onKill: () => void
  /** Open a shell in the focused session's worktree. */
  onTerminal: () => void
  colorById?: Record<string, SessionColor>
  /** Right-click → a color for the session, or null for none. */
  onSetColor?: (sessionId: string, color: SessionColor | null) => void
}

/** Deck's "Recent activity" shows the latest five unread; "View all" is the history. */
const UNREAD_SHOWN = 5

export function AgentRail({
  sessions,
  focusedId,
  attentionById,
  activity,
  header,
  showButtons,
  onCommandBar,
  onChanges,
  onFocus,
  onSelectActivity,
  onNew,
  onStart,
  onStop,
  onKill,
  onTerminal,
  colorById = {},
  onSetColor,
}: AgentRailProps) {
  const [showAll, setShowAll] = useState(false)
  const [colorMenu, setColorMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null)
  const colorMenuRef = useRef<HTMLDivElement>(null)
  const closeColorMenu = useCallback(() => setColorMenu(null), [])
  useDismiss(colorMenu !== null, closeColorMenu, colorMenuRef)
  const focusedSession = focusedId === null ? undefined : sessions.find((session) => session.id === focusedId)
  const focusedRunning = focusedSession !== undefined && isSessionRunning(focusedSession)
  const unread = activity.filter((item) => !item.read)
  const items = showAll ? activity : unread.slice(0, UNREAD_SHOWN)
  return (
    <aside class="cockpit-rail" aria-label="Agent rail">
      <header class="cockpit-rail__header">
        <h1 title={header.title}>{header.title}</h1>
        <p class="cockpit-muted">{header.meta}</p>
      </header>
      {showButtons ? (
        <div class="cockpit-rail__actions" aria-label="Session actions">
          <button type="button" onClick={onNew} title="New agent (⌘T)">New</button>
          {/* Every button below acts on the focused session, and says which one. */}
          <span class="cockpit-rail__target">{focusedSession ? focusedSession.name : 'no session selected'}</span>
          <div class="cockpit-rail__row">
            <button type="button" onClick={onStart} disabled={!focusedSession || focusedRunning}>Start</button>
            <button type="button" onClick={onStop} disabled={!focusedSession || !focusedRunning}>Stop</button>
            <button type="button" onClick={onTerminal} disabled={!focusedSession}
              title={focusedSession ? `A shell in ${focusedSession.name}'s worktree (⌘⇧T)` : undefined}>Terminal</button>
            <button type="button" onClick={onChanges} disabled={!focusedSession}
              title={focusedSession ? `What landing ${focusedSession.name} would bring in` : undefined}>Changes</button>
            <button type="button" class="is-danger" onClick={onKill} disabled={!focusedSession}>Kill</button>
          </div>
        </div>
      ) : (
        <button type="button" class="cockpit-rail__command" onClick={onCommandBar}>
          <span>Run a command…</span>
          <kbd>⌘K</kbd>
        </button>
      )}
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
                  onContextMenu={(e) => {
                    if (!onSetColor) return
                    e.preventDefault()
                    setColorMenu({ sessionId: session.id, x: e.clientX, y: e.clientY })
                  }}
                >
                  <span class="cockpit-rail__meta">
                    <span class="cockpit-rail__name">
                      {colorById[session.id] ? (
                        <span class="cockpit-dot" style={{ background: `var(--cw-${colorById[session.id]})` }} aria-hidden="true" />
                      ) : null}
                      {session.name}
                    </span>
                    {session.agentKind ? (
                      <span class="cockpit-muted">{session.agentKind}</span>
                    ) : null}
                    {meta ? (
                      <span class="cockpit-muted" title={tierCoverageSentence(session.enforcementTier ?? '')}>{meta}</span>
                    ) : null}
                    {session.latestWords ? (
                      // What the agent last said: tells you whether it needs you without
                      // opening its pane.
                      <span class="cockpit-rail__words" title={session.latestWords}>
                        “{session.latestWords}”
                      </span>
                    ) : null}
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
      {colorMenu !== null && onSetColor ? (
        <div class="cockpit-menu" role="menu" aria-label="Session color" style={{ left: `${colorMenu.x}px`, top: `${colorMenu.y}px` }}
          ref={colorMenuRef}>
          <div class="cockpit-swatches">
            {SESSION_COLORS.map((c) => (
              <button type="button" key={c} role="menuitem" aria-label={`Color ${c}`} class="cockpit-swatch"
                style={{ background: `var(--cw-${c})` }}
                onClick={() => { onSetColor(colorMenu.sessionId, c); setColorMenu(null) }} />
            ))}
          </div>
          <button type="button" role="menuitem" onClick={() => { onSetColor(colorMenu.sessionId, null); setColorMenu(null) }}>Default</button>
        </div>
      ) : null}
    </aside>
  )
}
