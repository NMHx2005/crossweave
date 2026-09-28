import type { SessionDiff } from '../lib/patch'
import type { CockpitChannel, CockpitEvent } from '../../electron/channels'
import { parseSessionList, type ListedSession } from '../lib/sessions'
import type { TerminalAppearance } from '../../../../src/core/settings.js'
import type { FolderInfo } from '../../electron/folder-open'

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

type Invoke = <T = unknown>(channel: CockpitChannel, payload?: unknown) => Promise<T>
type Listen = (event: CockpitEvent, cb: (payload: unknown) => void) => () => void

/** Typed renderer wrappers over the closed preload bridge, through `invoke` / `listen`. */
function makeApi(invoke: Invoke, listen: Listen) {
  return {
    ensureWorkspace(projectRoot?: string): Promise<WorkspaceEnsureResult> {
      return invoke('workspace.ensure', projectRoot ? { projectRoot } : undefined)
    },
    listSessions(): Promise<ListedSession[]> {
      return invoke('session.list').then(parseSessionList)
    },
    newSession(payload: { name: string; worktree?: boolean; base?: string }): Promise<unknown> {
      return invoke('session.new', payload)
    },
    startSession(idOrName: string): Promise<unknown> {
      return invoke('session.start', { idOrName })
    },
    /** `launcher`: a launcher id from Settings to run in the shell; 'terminal' or none for a plain shell. */
    resumeSession(idOrName: string, launcher?: string): Promise<unknown> {
      return invoke('session.resume', { idOrName, ...(launcher === undefined || launcher === 'terminal' ? {} : { launcher }) })
    },
    listLaunchers(): Promise<LauncherOption[]> {
      return invoke('launchers.list')
    },
    attachSession(idOrName: string): Promise<SessionAttachResult> {
      return invoke('session.attach', { idOrName })
    },
    detachSession(sessionId: string): Promise<unknown> {
      return invoke('session.detach', { sessionId })
    },
    sendInput(idOrName: string, data: string): Promise<unknown> {
      return invoke('session.input', { idOrName, data })
    },
    resizeSession(idOrName: string, cols: number, rows: number): Promise<unknown> {
      return invoke('session.resize', { idOrName, cols, rows })
    },
    stopSession(idOrName: string): Promise<unknown> {
      return invoke('session.stop', { idOrName })
    },
    killSession(idOrName: string, removeWorktree?: boolean): Promise<unknown> {
      return invoke('session.kill', { idOrName, removeWorktree })
    },
    /** Gone from the rail: its worktree and branch deleted (the daemon refuses a live one). */
    removeSession(idOrName: string): Promise<unknown> {
      return invoke('session.rm', { idOrName })
    },
    /** `projectRoot`: another open project's (the bridge routes it); the active one's by default. */
    convergeStatus(projectRoot?: string): Promise<unknown> {
      return invoke('converge.status', projectRoot === undefined ? undefined : { projectRoot })
    },
    landSession(idOrName: string, force?: boolean, projectRoot?: string): Promise<unknown> {
      return invoke('land.session', { idOrName, force, ...(projectRoot === undefined ? {} : { projectRoot }) })
    },
    /** What this window last had open, so a restart can put it back (Horizon B journal). */
    journalGet(): Promise<unknown> {
      return invoke('journal.get')
    },
    journalSet(openTabs: string[]): Promise<unknown> {
      return invoke('journal.set', { openTabs })
    },
    openTerminal(idOrName: string): Promise<TerminalInfo> {
      return invoke('terminal.open', { idOrName })
    },
    listTerminals(): Promise<TerminalInfo[]> {
      return invoke('terminal.list')
    },
    attachTerminal(terminalId: string): Promise<unknown> {
      return invoke('terminal.attach', { terminalId })
    },
    terminalInput(terminalId: string, data: string): Promise<unknown> {
      return invoke('terminal.input', { terminalId, data })
    },
    resizeTerminal(terminalId: string, cols: number, rows: number): Promise<unknown> {
      return invoke('terminal.resize', { terminalId, cols, rows })
    },
    closeTerminal(terminalId: string): Promise<unknown> {
      return invoke('terminal.close', { terminalId })
    },
    onTerminalData(cb: (payload: unknown) => void): () => void {
      return listen('terminal.data', cb)
    },
    onTerminalExit(cb: (payload: unknown) => void): () => void {
      return listen('terminal.exit', cb)
    },
    getSettings(): Promise<unknown> {
      return invoke('settings.get')
    },
    setSettings(settings: unknown): Promise<unknown> {
      return invoke('settings.set', { settings })
    },
    /** One line on the session ('' clears it). */
    setNote(idOrName: string, note: string): Promise<unknown> {
      return invoke('session.note', { idOrName, note })
    },
    renameSession(idOrName: string, newName: string, projectRoot?: string): Promise<unknown> {
      return invoke('session.rename', { idOrName, newName, ...(projectRoot === undefined ? {} : { projectRoot }) })
    },
    collectGarbage(force: boolean, projectRoot?: string): Promise<{ removed?: string[]; kept?: string[] }> {
      return invoke('workspace.gc', { force, ...(projectRoot === undefined ? {} : { projectRoot }) })
    },
    sessionDiff(idOrName: string): Promise<SessionDiff> {
      return invoke('session.diff', { idOrName })
    },
    listFiles(idOrName: string): Promise<string[]> {
      return invoke('file.list', { idOrName })
    },
    readFile(idOrName: string, path: string): Promise<{ content: string; mtimeMs: number }> {
      return invoke('file.read', { idOrName, path })
    },
    writeFile(idOrName: string, path: string, content: string, expectedMtimeMs?: number): Promise<{ mtimeMs: number }> {
      return invoke('file.write', { idOrName, path, content, expectedMtimeMs })
    },
    listBranches(): Promise<string[]> {
      return invoke('git.branches')
    },
    openInEditor(sessionId: string, path: string, line?: number, col?: number): Promise<{ ok: boolean; inApp?: boolean; path?: string; line?: number }> {
      return invoke('editor.open', { sessionId, path, line, col })
    },
    onCommand(cb: (payload: unknown) => void): () => void {
      return listen('cockpit.command', cb)
    },
    onSessionData(cb: (payload: unknown) => void): () => void {
      return listen('session.data', cb)
    },
    onSessionExit(cb: (payload: unknown) => void): () => void {
      return listen('session.exit', cb)
    },
    onTuiEvent(cb: (payload: unknown) => void): () => void {
      return listen('tui.event', cb)
    },
    onTuiInvalidate(cb: (payload: unknown) => void): () => void {
      return listen('tui.invalidate', cb)
    },
    onDaemonGone(cb: (payload: unknown) => void): () => void {
      return listen('daemon.gone', cb)
    },
    /** Every project open in this window, and which one is on the stage. */
    listProjects(): Promise<{ active: string | undefined; open: string[] }> {
      return invoke('projects.list')
    },
    projectSessions(projectRoot: string): Promise<ProjectSnapshot> {
      return invoke<{ projectRoot: string; name: string; sessions: unknown; converge: unknown }>('projects.sessions', { projectRoot })
        .then((r) => ({ projectRoot: r.projectRoot, name: r.name, sessions: parseSessionList(r.sessions), converge: r.converge }))
    },
    closeProject(projectRoot: string): Promise<unknown> {
      return invoke('projects.close', { projectRoot })
    },
    /** The rail's project order: the open projects, rearranged. */
    reorderProjects(roots: string[]): Promise<unknown> {
      return invoke('projects.reorder', { roots })
    },
    /** Finder, at a project's folder — or a session's, with `sessionId`. */
    revealFolder(projectRoot: string, sessionId?: string): Promise<{ ok: boolean }> {
      return invoke('folder.reveal', { projectRoot, ...(sessionId === undefined ? {} : { sessionId }) })
    },
    /** The editor from Settings, opened on a project's or a session's folder. */
    openFolderInEditor(projectRoot: string, sessionId?: string): Promise<{ ok: boolean }> {
      return invoke('folder.openInEditor', { projectRoot, ...(sessionId === undefined ? {} : { sessionId }) })
    },
    /** Rebuild the menu after Settings → Keyboard changed. */
    refreshMenu(): Promise<unknown> {
      return invoke('menu.refresh')
    },
    /** The font families installed on this Mac, for the font pickers. */
    listFonts(): Promise<Array<{ family: string; mono: boolean }>> {
      return invoke('fonts.list')
    },
    /** Settings → Terminal: which terminals have settings on this machine. */
    terminalImportSources(): Promise<{ ghostty: boolean; iterm2: boolean }> {
      return invoke('terminal.importSources')
    },
    /** A read-only import of Ghostty's or iTerm2's look, as a draft for Settings. */
    importTerminal(from: 'ghostty' | 'iterm2'): Promise<TerminalImport> {
      return invoke('terminal.import', { from })
    },
    /** The Dock's number: sessions waiting for the user (0 clears it). */
    setBadge(count: number): Promise<unknown> {
      return invoke('app.badge', { count })
    },
    /** What a folder is before it is opened: a repository, a subfolder of one, or plain (with the repositories inside). */
    inspectFolder(path: string): Promise<FolderInfo> {
      return invoke('folder.inspect', { path })
    },
    /** `git init` (and an empty first commit when git knows the user) in a plain folder. */
    initGit(path: string): Promise<{ ok: boolean; committed: boolean; message: string }> {
      return invoke('folder.initGit', { path })
    },
    /** Recently opened project folders that still exist, newest first. */
    recentProjects(): Promise<string[]> {
      return invoke('projects.recent')
    },
    /** The folder picker; null when cancelled. */
    pickProject(): Promise<string | null> {
      return invoke<{ projectRoot: string | null }>('projects.pick').then((r) => r.projectRoot)
    },
    /** Some open project's sessions changed (any project: the rail lists them all). */
    onProjectInvalidate(cb: (projectRoot: string) => void): () => void {
      return listen('tui.invalidate', (payload) => {
        const root = (payload as { projectRoot?: unknown } | null)?.projectRoot
        if (typeof root === 'string') cb(root)
      })
    },
  }
}

export type CockpitApi = ReturnType<typeof makeApi>

/** The window's API: calls go to the project on the stage unless they name another. */
export const cockpitApi: CockpitApi = makeApi(cockpitInvoke, cockpitListen)

/**
 * Channels the bridge or the main process answers for the whole window; a project's
 * view must not stamp its root on them (for `projects.close` the root IS the argument).
 */
const WINDOW_CHANNELS = new Set<CockpitChannel>([
  'workspace.ensure', 'projects.list', 'projects.pick', 'projects.reorder', 'projects.recent', 'projects.sessions',
  'folder.inspect', 'folder.initGit',
  'projects.close', 'app.badge', 'folder.reveal', 'folder.openInEditor',
  'terminal.importSources', 'terminal.import', 'fonts.list', 'menu.refresh',
])

/** `payload` with `projectRoot` added, unless the call already names one or is window-wide. */
export function withProjectRoot(channel: CockpitChannel, payload: unknown, projectRoot: string): unknown {
  if (WINDOW_CHANNELS.has(channel)) return payload
  if (payload === undefined || payload === null) return { projectRoot }
  if (typeof payload !== 'object' || Array.isArray(payload)) return payload
  const record = payload as Record<string, unknown>
  return typeof record.projectRoot === 'string' ? record : { ...record, projectRoot }
}

/**
 * The API as one project's view uses it: every call goes to that project's daemon, and
 * only that project's events arrive — so a view off the stage keeps working (its panes
 * stream, its rail row updates) while another project is shown.
 */
export function projectApi(projectRoot: string): CockpitApi {
  return makeApi(
    (channel, payload) => cockpitInvoke(channel, withProjectRoot(channel, payload, projectRoot)),
    (event, cb) => cockpitListen(event, (payload) => {
      if ((payload as { projectRoot?: unknown } | null)?.projectRoot === projectRoot) cb(payload)
    }),
  )
}

export type TerminalImport =
  | { ok: true; appearance: TerminalAppearance; notes: string[] }
  | { ok: false; reason: string }

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
