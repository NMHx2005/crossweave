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
  newSession(payload: { name: string; worktree?: boolean; base?: string }): Promise<unknown> {
    return cockpitInvoke('session.new', payload)
  },
  startSession(idOrName: string): Promise<unknown> {
    return cockpitInvoke('session.start', { idOrName })
  },
  /** `launcher`: a launcher id from Settings to run in the shell; 'terminal' or none for a plain shell. */
  resumeSession(idOrName: string, launcher?: string): Promise<unknown> {
    return cockpitInvoke('session.resume', { idOrName, ...(launcher === undefined || launcher === 'terminal' ? {} : { launcher }) })
  },
  listLaunchers(): Promise<LauncherOption[]> {
    return cockpitInvoke('launchers.list')
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
  /** Gone from the rail: its worktree and branch deleted (the daemon refuses a live one). */
  removeSession(idOrName: string): Promise<unknown> {
    return cockpitInvoke('session.rm', { idOrName })
  },
  /** `projectRoot`: another open project's (the bridge routes it); the active one's by default. */
  convergeStatus(projectRoot?: string): Promise<unknown> {
    return cockpitInvoke('converge.status', projectRoot === undefined ? undefined : { projectRoot })
  },
  landSession(idOrName: string, force?: boolean, projectRoot?: string): Promise<unknown> {
    return cockpitInvoke('land.session', { idOrName, force, ...(projectRoot === undefined ? {} : { projectRoot }) })
  },
  /** What this window last had open, so a restart can put it back (Horizon B journal). */
  journalGet(): Promise<unknown> {
    return cockpitInvoke('journal.get')
  },
  journalSet(openTabs: string[]): Promise<unknown> {
    return cockpitInvoke('journal.set', { openTabs })
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
  getSettings(): Promise<unknown> {
    return cockpitInvoke('settings.get')
  },
  setSettings(settings: unknown): Promise<unknown> {
    return cockpitInvoke('settings.set', { settings })
  },
  renameSession(idOrName: string, newName: string, projectRoot?: string): Promise<unknown> {
    return cockpitInvoke('session.rename', { idOrName, newName, ...(projectRoot === undefined ? {} : { projectRoot }) })
  },
  collectGarbage(force: boolean, projectRoot?: string): Promise<{ removed?: string[]; kept?: string[] }> {
    return cockpitInvoke('workspace.gc', { force, ...(projectRoot === undefined ? {} : { projectRoot }) })
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
  /** Every project open in this window, and which one is on the stage. */
  listProjects(): Promise<{ active: string | undefined; open: string[] }> {
    return cockpitInvoke('projects.list')
  },
  projectSessions(projectRoot: string): Promise<ProjectSnapshot> {
    return cockpitInvoke<{ projectRoot: string; name: string; sessions: unknown; converge: unknown }>('projects.sessions', { projectRoot })
      .then((r) => ({ projectRoot: r.projectRoot, name: r.name, sessions: parseSessionList(r.sessions), converge: r.converge }))
  },
  closeProject(projectRoot: string): Promise<unknown> {
    return cockpitInvoke('projects.close', { projectRoot })
  },
  /** The rail's project order: the open projects, rearranged. */
  reorderProjects(roots: string[]): Promise<unknown> {
    return cockpitInvoke('projects.reorder', { roots })
  },
  /** Finder, at a project's folder — or a session's, with `sessionId`. */
  revealFolder(projectRoot: string, sessionId?: string): Promise<{ ok: boolean }> {
    return cockpitInvoke('folder.reveal', { projectRoot, ...(sessionId === undefined ? {} : { sessionId }) })
  },
  /** The editor from Settings, opened on a project's or a session's folder. */
  openFolderInEditor(projectRoot: string, sessionId?: string): Promise<{ ok: boolean }> {
    return cockpitInvoke('folder.openInEditor', { projectRoot, ...(sessionId === undefined ? {} : { sessionId }) })
  },
  /** The Dock's number: sessions waiting for the user (0 clears it). */
  setBadge(count: number): Promise<unknown> {
    return cockpitInvoke('app.badge', { count })
  },
  /** The folder picker; null when cancelled. */
  pickProject(): Promise<string | null> {
    return cockpitInvoke<{ projectRoot: string | null }>('projects.pick').then((r) => r.projectRoot)
  },
  onProjectInvalidate(cb: (projectRoot: string) => void): () => void {
    return cockpitListen('project.invalidate', (payload) => {
      const root = (payload as { projectRoot?: unknown } | null)?.projectRoot
      if (typeof root === 'string') cb(root)
    })
  },
}

/** A launcher as the picker shows it: Settings' entry plus whether this machine has it. */
export type LauncherOption = {
  id: string
  label: string
  command: string
  env: Record<string, string>
  enabled: boolean
  builtin: boolean
  available: boolean
  /** A built-in's shipped label and command (for Reset). */
  defaults?: { label: string; command: string }
}

/** One open project as the rail shows it. */
export type ProjectSnapshot = {
  projectRoot: string
  name: string
  sessions: ListedSession[]
  converge: unknown
}
