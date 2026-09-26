import type { SessionDiff } from '../lib/patch'
import type { CockpitChannel, CockpitEvent } from '../../electron/channels'
import { parseSessionList, type ListedSession } from '../lib/sessions'

export type { CockpitChannel, CockpitEvent, ListedSession }

export type WorkspaceEnsureResult = {
  projectRoot: string
  workspace: { id: string; name: string; rootPath: string }
}

export type SessionAttachResult = {
  ok: boolean
  sessionId: string
  name: string
}

export type TerminalInfo = {
  terminalId: string
  sessionId: string
  sessionName: string
}

export type AgentOption = {
  id: string
  label: string
  enabled: boolean
  builtin: boolean
  tier: string
  /** Whether its command resolves on the daemon's PATH. */
  available: boolean
}

export function cockpitInvoke<T = unknown>(channel: CockpitChannel, payload?: unknown): Promise<T> {
  return window.cockpit.invoke(channel, payload) as Promise<T>
}

export function cockpitListen(event: CockpitEvent, cb: (payload: unknown) => void): () => void {
  return window.cockpit.listen(event, cb)
}

/** Typed renderer wrappers over the closed preload bridge. */
export const cockpitApi = {
  ensureWorkspace(projectRoot?: string): Promise<WorkspaceEnsureResult> {
    return cockpitInvoke('workspace.ensure', projectRoot ? { projectRoot } : undefined)
  },
  listSessions(): Promise<ListedSession[]> {
    return cockpitInvoke('session.list').then(parseSessionList)
  },
  newSession(payload: { name: string; agent: string; worktree?: boolean; base?: string; args?: string[] }): Promise<unknown> {
    return cockpitInvoke('session.new', payload)
  },
  startSession(idOrName: string): Promise<unknown> {
    return cockpitInvoke('session.start', { idOrName })
  },
  /** `args` replaces the session's remembered launch flags; omitted reuses them. */
  resumeSession(idOrName: string, args?: string[]): Promise<unknown> {
    return cockpitInvoke('session.resume', { idOrName, ...(args === undefined ? {} : { args }) })
  },
  attachSession(idOrName: string): Promise<SessionAttachResult> {
    return cockpitInvoke('session.attach', { idOrName })
  },
  detachSession(sessionId: string): Promise<unknown> {
    return cockpitInvoke('session.detach', { sessionId })
  },
  sendInput(idOrName: string, data: string): Promise<unknown> {
    return cockpitInvoke('session.input', { idOrName, data })
  },
  resizeSession(idOrName: string, cols: number, rows: number): Promise<unknown> {
    return cockpitInvoke('session.resize', { idOrName, cols, rows })
  },
  stopSession(idOrName: string): Promise<unknown> {
    return cockpitInvoke('session.stop', { idOrName })
  },
  killSession(idOrName: string, removeWorktree?: boolean): Promise<unknown> {
    return cockpitInvoke('session.kill', { idOrName, removeWorktree })
  },
  convergeStatus(): Promise<unknown> {
    return cockpitInvoke('converge.status')
  },
  landSession(idOrName: string, force?: boolean): Promise<unknown> {
    return cockpitInvoke('land.session', { idOrName, force })
  },
  /** What this window last had open, so a restart can put it back (Horizon B journal). */
  journalGet(): Promise<unknown> {
    return cockpitInvoke('journal.get')
  },
  journalSet(openTabs: string[]): Promise<unknown> {
    return cockpitInvoke('journal.set', { openTabs })
  },
  usageSummary(payload?: { groupBy?: string }): Promise<unknown> {
    return cockpitInvoke('usage.summary', payload)
  },
  openTerminal(idOrName: string): Promise<TerminalInfo> {
    return cockpitInvoke('terminal.open', { idOrName })
  },
  listTerminals(): Promise<TerminalInfo[]> {
    return cockpitInvoke('terminal.list')
  },
  attachTerminal(terminalId: string): Promise<unknown> {
    return cockpitInvoke('terminal.attach', { terminalId })
  },
  terminalInput(terminalId: string, data: string): Promise<unknown> {
    return cockpitInvoke('terminal.input', { terminalId, data })
  },
  resizeTerminal(terminalId: string, cols: number, rows: number): Promise<unknown> {
    return cockpitInvoke('terminal.resize', { terminalId, cols, rows })
  },
  closeTerminal(terminalId: string): Promise<unknown> {
    return cockpitInvoke('terminal.close', { terminalId })
  },
  onTerminalData(cb: (payload: unknown) => void): () => void {
    return cockpitListen('terminal.data', cb)
  },
  onTerminalExit(cb: (payload: unknown) => void): () => void {
    return cockpitListen('terminal.exit', cb)
  },
  listAgents(): Promise<AgentOption[]> {
    return cockpitInvoke('agents.list')
  },
  getSettings(): Promise<unknown> {
    return cockpitInvoke('settings.get')
  },
  setSettings(settings: unknown): Promise<unknown> {
    return cockpitInvoke('settings.set', { settings })
  },
  renameSession(idOrName: string, newName: string): Promise<unknown> {
    return cockpitInvoke('session.rename', { idOrName, newName })
  },
  collectGarbage(force: boolean): Promise<unknown> {
    return cockpitInvoke('workspace.gc', { force })
  },
  sessionDiff(idOrName: string): Promise<SessionDiff> {
    return cockpitInvoke('session.diff', { idOrName })
  },
  listFiles(idOrName: string): Promise<string[]> {
    return cockpitInvoke('file.list', { idOrName })
  },
  readFile(idOrName: string, path: string): Promise<{ content: string; mtimeMs: number }> {
    return cockpitInvoke('file.read', { idOrName, path })
  },
  writeFile(idOrName: string, path: string, content: string, expectedMtimeMs?: number): Promise<{ mtimeMs: number }> {
    return cockpitInvoke('file.write', { idOrName, path, content, expectedMtimeMs })
  },
  listBranches(): Promise<string[]> {
    return cockpitInvoke('git.branches')
  },
  openInEditor(sessionId: string, path: string, line?: number, col?: number): Promise<{ ok: boolean; inApp?: boolean; path?: string; line?: number }> {
    return cockpitInvoke('editor.open', { sessionId, path, line, col })
  },
  onCommand(cb: (payload: unknown) => void): () => void {
    return cockpitListen('cockpit.command', cb)
  },
  onSessionData(cb: (payload: unknown) => void): () => void {
    return cockpitListen('session.data', cb)
  },
  onSessionExit(cb: (payload: unknown) => void): () => void {
    return cockpitListen('session.exit', cb)
  },
  onTuiEvent(cb: (payload: unknown) => void): () => void {
    return cockpitListen('tui.event', cb)
  },
  onTuiInvalidate(cb: (payload: unknown) => void): () => void {
    return cockpitListen('tui.invalidate', cb)
  },
  onDaemonGone(cb: (payload: unknown) => void): () => void {
    return cockpitListen('daemon.gone', cb)
  },
}
