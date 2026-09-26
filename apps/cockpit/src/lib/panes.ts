import type { ListedSession, TerminalInfo } from '../host/cockpit-api'

export const MAX_PANES = 4

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

/** Terminals take grid slots too, but never more than this many at once. */
const MAX_TERMINAL_PANES = 2

export type Pane =
  | { kind: 'session'; session: ListedSession }
  | { kind: 'terminal'; terminal: TerminalInfo }

/**
 * The grid's panes: sessions first (the focused one always kept), then the newest
 * terminals. Terminals take their slots from unfocused sessions — a shell was asked
 * for just now, and the four-pane grid has no fifth slot to give it.
 */
export function pickPanes(
  sessions: ListedSession[],
  terminals: TerminalInfo[],
  focusedId: string | null,
): Pane[] {
  const shownTerminals = terminals.slice(-MAX_TERMINAL_PANES)
  const sessionSlots = Math.max(MAX_PANES - shownTerminals.length, 1)
  return [
    ...pickPaneSessions(sessions, focusedId, sessionSlots).map((session) => ({ kind: 'session' as const, session })),
    ...shownTerminals.map((terminal) => ({ kind: 'terminal' as const, terminal })),
  ]
}
