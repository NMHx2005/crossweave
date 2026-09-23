import { guardRestore } from '../../../../src/domain/journal.js'
import type { ListedSession } from './sessions'
import { parseConvergeStatus, type ConvergeStatus } from './land-actions'

export type CockpitHostApi = {
  ensureWorkspace: () => Promise<unknown>
  listSessions: () => Promise<ListedSession[]>
  convergeStatus: () => Promise<unknown>
  journalGet: () => Promise<unknown>
  newSession: (payload: { name: string; agent: string; worktree?: boolean }) => Promise<unknown>
  resumeSession: (idOrName: string) => Promise<unknown>
  onTuiInvalidate: (cb: (payload: unknown) => void) => () => void
  onTuiEvent: (cb: (payload: unknown) => void) => () => void
  onDaemonGone: (cb: (payload: unknown) => void) => () => void
}

export type LoadedWorkspace = {
  sessions: ListedSession[]
  converge: ConvergeStatus
  /** Session ids the last window had open, most recently focused first. */
  journalTabs: string[]
}

/**
 * The journal's tab list from whatever `journal.get` returned. A client-side parse
 * rather than a cast: the daemon is the writer, but a stale file, a downgrade or a
 * hand-edited journal must degrade to "nothing to restore", not to a crash at boot.
 */
export function parseJournalTabs(payload: unknown): string[] {
  const record = payload as { openTabs?: unknown } | null
  if (!record || !Array.isArray(record.openTabs)) return []
  return record.openTabs.filter((tab): tab is string => typeof tab === 'string')
}

/**
 * Sessions in journal order, then everything else in the order the daemon listed it.
 *
 * The restore is a reordering, never a filter: a session that is not in the journal
 * (started from the CLI while the window was closed) still gets a pane, it just comes
 * after the ones the window had. Ids the journal names but the daemon no longer has are
 * dropped, and the guard keeps a repeated id from opening a second pane on the same
 * session — two attaches on one session fight over the same pty.
 */
export function orderSessionsByJournal(sessions: ListedSession[], tabs: string[]): ListedSession[] {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const seen = new Set<string>()
  const restored = guardRestore(tabs, seen)
    .map((id) => byId.get(id))
    .filter((session): session is ListedSession => session !== undefined)
  return [...restored, ...sessions.filter((session) => !seen.has(session.id))]
}

/**
 * Re-attach then refresh. Used on boot, tui.invalidate, and daemon.gone so a
 * dropped daemon does not leave the renderer stuck on a dead client.
 */
export async function loadWorkspace(
  api: Pick<CockpitHostApi, 'ensureWorkspace' | 'listSessions' | 'convergeStatus' | 'journalGet'>,
): Promise<LoadedWorkspace> {
  await api.ensureWorkspace()
  const sessions = await api.listSessions()
  const converge = await api.convergeStatus().catch(() => undefined)
  // Best effort: a daemon too old to know journal.get, or a failed read, costs the
  // restore and nothing else. A window that cannot list sessions has already thrown.
  const journal = await api.journalGet().catch(() => undefined)
  return { sessions, converge: parseConvergeStatus(converge), journalTabs: parseJournalTabs(journal) }
}

export type RefreshSource = 'invalidate' | 'event' | 'gone'

/** After daemon.gone reconnect, session ids often stay the same — panes must remount to re-attach. */
export function shouldBumpPaneAttach(source: RefreshSource): boolean {
  return source === 'gone'
}

export function subscribeCockpitHost(
  api: Pick<CockpitHostApi, 'onTuiInvalidate' | 'onTuiEvent' | 'onDaemonGone'>,
  handlers: {
    refresh: (source: RefreshSource) => void
    onEvent?: (payload: unknown) => void
  },
): () => void {
  const unsubInvalidate = api.onTuiInvalidate(() => handlers.refresh('invalidate'))
  const unsubEvent = api.onTuiEvent((payload) => {
    handlers.onEvent?.(payload)
    handlers.refresh('event')
  })
  const unsubGone = api.onDaemonGone(() => handlers.refresh('gone'))
  return () => {
    unsubInvalidate()
    unsubEvent()
    unsubGone()
  }
}

function recordOf(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

/**
 * Match CLI `cw attach --start` (default true): create the row, then resume so
 * a pane can session.attach to a running PTY.
 */
export async function createAndStartSession(
  api: Pick<CockpitHostApi, 'newSession' | 'resumeSession'>,
  payload: { name: string; agent: string; worktree?: boolean },
): Promise<unknown> {
  const created = await api.newSession(payload)
  const record = recordOf(created)
  const idOrName =
    (typeof record.id === 'string' && record.id.length > 0 && record.id) ||
    (typeof record.name === 'string' && record.name.length > 0 && record.name) ||
    payload.name
  await api.resumeSession(idOrName)
  return created
}

/** Action / transient errors must not flip the stage to `error` while panes exist. */
export function stageStatusAfterFailure(sessionCount: number): 'ready' | 'error' {
  return sessionCount > 0 ? 'ready' : 'error'
}

export function stageStatusAfterLoad(sessionCount: number): 'ready' | 'empty' {
  return sessionCount === 0 ? 'empty' : 'ready'
}

/**
 * Run a cockpit action then refresh the session list. On partial failure (e.g.
 * session.new ok but session.resume throws), refresh still runs so new rows appear.
 */
export async function runCockpitAction(
  action: () => Promise<unknown>,
  refresh: (partialFailure: boolean) => Promise<void>,
): Promise<string | undefined> {
  try {
    await action()
    await refresh(false)
    return undefined
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await refresh(true)
    return message
  }
}
