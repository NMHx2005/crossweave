import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { activityFromEvent } from '../../../../src/domain/activity.js'
import { projectApi, type LauncherOption, type ListedSession, type TerminalInfo } from '../host/cockpit-api'
import { nextAttentionSession } from '../lib/attention-jump'
import { QuickPicker, type NewSessionOptions, type NewSessionRequest } from './QuickPicker'
import { StoppedBar } from './StoppedBar'
import type { ConfirmRequest } from './ConfirmDialog'
import { ChangesPane } from './ChangesPane'
import { CommandBar } from './CommandBar'
import { rememberLine, type Command } from '../lib/commands'
import { QuickOpen } from './QuickOpen'
import { FilePane } from './FilePane'
import { BrowserPane } from './BrowserPane'
import type { NotifyPrefs } from './SettingsPanel'
import { readColors, writeColors, type SessionColor } from '../lib/colors'
import { deriveAttention, parseLandabilityByName, type AttentionKind, type Landability } from '../lib/attention'
import {
  loadWorkspace,
  plainErrorMessage,
  runCockpitAction,
  shouldBumpPaneAttach,
  stageStatusAfterFailure,
  stageStatusAfterLoad,
  subscribeCockpitHost,
} from '../lib/cockpit-host'
import {
  landAllReady,
  landSelected,
  landVerdict,
  parseConvergeStatus,
  type ConvergeDetail,
  type ConvergeStatus,
  type LandResult,
} from '../lib/land-actions'
import {
  closeOthers,
  closePane,
  closeTab,
  closeToRight,
  emptyStage,
  findPane,
  focusPane,
  fromSavedLayout,
  locatePane,
  moveTab,
  openInNewTab,
  paneKeys,
  parseStoredStage,
  placeBeside,
  replacePane,
  resizeSplit,
  setPinned,
  splitPane,
  syncStage,
  toSavedLayout,
  type PaneRef,
  type SavedLayout,
  type SplitDir,
  type StageState,
} from '../lib/layout'
import type { RowAction } from './Sidebar'
import { Stage, type StageStatus } from './Stage'
import { sessionsThatStartedRunning } from '../lib/sessions'
import { agentName, newlyAsking } from '../lib/rail'
import { ProjectApiContext } from './project-context'
import { LAST_LAUNCHER_KEY, readString, readStringList, writeString, writeStringList } from './storage'

const EMPTY_CONVERGE: ConvergeStatus = { ready: [], unknown: [], blocked: [] }
const COMMAND_HISTORY_KEY = 'cw.command-history.v1'

/** Where this window keeps a project's tabs: per project, in this browser profile only. */
const stageKey = (projectRoot: string): string => `cw.stage.v1:${projectRoot}`

function readStoredStage(projectRoot: string): StageState | null {
  try {
    const text = window.localStorage.getItem(stageKey(projectRoot))
    return text === null ? null : parseStoredStage(text)
  } catch {
    return null
  }
}

/** Something the host asks a project's view to do (from the rail, a menu, a switch). */
export type ViewAction =
  | { kind: 'new' }
  | { kind: 'create'; name: string; options: NewSessionOptions; launcher: string }
  | { kind: 'row'; sessionId: string; action: RowAction | 'focus' }
  | { kind: 'land-all' }

/** What the rail and the Dock need from a live view. */
export type ViewReport = {
  sessions: ListedSession[]
  attentionById: Record<string, AttentionKind>
  focusedId: string | null
  colors: Record<string, SessionColor>
}

export type ViewHandle = {
  run: (action: ViewAction) => void
  /** A menu accelerator meant for the project on the stage (⌘T, ⌘K, ⌘D, …). */
  command: (name: string) => void
  setColor: (sessionId: string, color: SessionColor | null) => void
}

/** The window-wide things a view reaches through its host. */
export type ViewHost = {
  askConfirm: (request: ConfirmRequest) => Promise<boolean>
  toast: (message: string, tone?: 'info' | 'error') => void
  openSettings: () => void
  /** Bring this project on the stage (a notification was clicked). */
  activate: () => void
  /** The ⌘T picker chose another project: create it there. */
  createElsewhere: (request: NewSessionRequest) => void
  defaultsFor: (projectRoot: string) => { launcher?: string; worktree: boolean; base?: string }
  projects: Array<{ projectRoot: string; name: string }>
  notify: NotifyPrefs
  sidebarHidden: boolean
  onToggleSidebar: () => void
  report: (projectRoot: string, report: ViewReport | null) => void
  register: (projectRoot: string, handle: ViewHandle | null) => void
  /** Actions asked for before this view existed or had loaded. */
  takePending: (projectRoot: string) => ViewAction[]
}

/**
 * One project's stage: its sessions, tabs, splits and terminals, kept mounted while
 * another project is shown, so its panes keep streaming and nothing re-attaches when
 * the user comes back. Every call goes to this project's daemon (projectApi), whatever
 * project the window has on the stage.
 */
export function ProjectView({ projectRoot, visible, host }: { projectRoot: string; visible: boolean; host: ViewHost }) {
  const api = useMemo(() => projectApi(projectRoot), [projectRoot])
  const hostRef = useRef(host)
  hostRef.current = host
  const visibleRef = useRef(visible)
  visibleRef.current = visible

  const [sessions, setSessions] = useState<ListedSession[]>([])
  const [stage, setStage] = useState<StageState>(emptyStage)
  const [status, setStatus] = useState<StageStatus>('loading')
  const [error, setError] = useState<string | null>(null)
  const [landabilityByName, setLandabilityByName] = useState<Map<string, Landability>>(() => new Map())
  const [converge, setConverge] = useState<ConvergeStatus>(EMPTY_CONVERGE)
  const [landBusy, setLandBusy] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [layouts, setLayouts] = useState<Record<string, SavedLayout>>({})
  /** Bumped on every successful load, so open Changes panes refetch after new work. */
  const [sessionsRevision, setSessionsRevision] = useState(0)
  const [convergeDetail, setConvergeDetail] = useState<ConvergeDetail>({ pairwise: [], empty: [], baseBranch: null })
  const [commandBarOpen, setCommandBarOpen] = useState(false)
  const [commandHistory, setCommandHistory] = useState<string[]>(() => readStringList(COMMAND_HISTORY_KEY))
  const [branches, setBranches] = useState<string[]>([])
  /** Non-null while ⌘P is open: the session whose worktree it searches. */
  const [quickOpen, setQuickOpen] = useState<{ sessionId: string; name: string; files: string[] } | null>(null)
  const [colors, setColors] = useState<Record<string, SessionColor>>(() => readColors(projectRoot))
  /** The launchers a new session can start with, as of the last picker or command bar. */
  const [launchers, setLaunchers] = useState<LauncherOption[]>([])
  const [paneAttachEpoch, setPaneAttachEpoch] = useState(0)
  const [paneAttachBumps, setPaneAttachBumps] = useState<Record<string, number>>({})
  const lastJournalRef = useRef('')
  const cancelledRef = useRef(false)
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  /** What the previous load saw; null until the first load (see syncStage). */
  const knownRef = useRef<{ sessionIds: Set<string>; terminalIds: Set<string> } | null>(null)
  /** Actions that arrived before the first load: they need the session list. */
  const queuedRef = useRef<ViewAction[]>([])

  const load = useCallback(async (opts?: { bumpAttach?: boolean }): Promise<void> => {
    try {
      // Never `workspace.ensure` here: that would take the stage for this project. The
      // bridge reaches it through its root (and reconnects to it after daemon.gone).
      const loaded = await loadWorkspace({ ...api, ensureWorkspace: async () => ({ projectRoot }) })
      if (cancelledRef.current) return
      const started = sessionsThatStartedRunning(sessionsRef.current, loaded.sessions)
      if (started.length > 0) {
        // Re-key only those panes: a global bump would remount every live terminal.
        setPaneAttachBumps((bumps) => {
          const out = { ...bumps }
          for (const id of started) out[id] = (out[id] ?? 0) + 1
          return out
        })
      }
      // Listed from the daemon, not kept only in this window: a reload must find the
      // shells it had open rather than leave them running with no pane.
      const openTerminals = await api.listTerminals().catch(() => [] as TerminalInfo[])
      if (cancelledRef.current) return
      // A session that just started waiting for you while you look elsewhere — another
      // app, or another project in this window — is worth a desktop notification.
      if (knownRef.current !== null && (!document.hasFocus() || !visibleRef.current)) {
        for (const s of newlyAsking(sessionsRef.current, loaded.sessions)) notifyAsking(s)
      }
      setSessions(loaded.sessions)
      setSessionsRevision((n) => n + 1)
      const firstLoad = knownRef.current === null
      const known = knownRef.current
      if (firstLoad) {
        void api.getSettings().then((s) => {
          const saved = (s as { layouts?: unknown } | null)?.layouts
          if (saved && typeof saved === 'object') setLayouts(saved as Record<string, SavedLayout>)
        }).catch(() => undefined)
      }
      setStage((prev) => {
        // The first load restores this project's tabs from the last window, if any.
        const base = firstLoad ? (readStoredStage(projectRoot) ?? prev) : prev
        return syncStage(base, { sessions: loaded.sessions, terminals: openTerminals }, known)
      })
      knownRef.current = {
        sessionIds: new Set(loaded.sessions.map((s) => s.id)),
        terminalIds: new Set(openTerminals.map((t) => t.terminalId)),
      }
      setConverge(loaded.converge)
      setConvergeDetail(loaded.convergeDetail)
      setLandabilityByName(parseLandabilityByName(loaded.converge))
      setStatus(stageStatusAfterLoad(loaded.sessions.length))
      setError(null)
      if (firstLoad) {
        const pending = [...queuedRef.current, ...hostRef.current.takePending(projectRoot)]
        queuedRef.current = []
        if (pending.length > 0) setTimeout(() => { for (const action of pending) runRef.current(action) }, 0)
      }
      if (opts?.bumpAttach) {
        // daemon.gone: every pane's socket is dead, so every pane re-attaches.
        setPaneAttachEpoch((current) => current + 1)
      }
    } catch (err) {
      if (cancelledRef.current) return
      setError(plainErrorMessage(err))
      setStatus(stageStatusAfterFailure(sessionsRef.current.length))
    }
  }, [api, projectRoot])

  useEffect(() => {
    cancelledRef.current = false
    void load()
    const unsub = subscribeCockpitHost(api, {
      refresh: (source) => {
        void load({ bumpAttach: shouldBumpPaneAttach(source) })
      },
      onEvent: (payload) => {
        // A land from anywhere (another window, the CLI) is worth a word.
        const item = activityFromEvent(payload)
        if (item) hostRef.current.toast(item.kind === 'landed' ? `landed ${item.session}` : `land failed: ${item.session}`)
      },
    })
    return () => {
      cancelledRef.current = true
      unsub()
    }
  }, [load, api])

  // Keep this project's tabs for the next window. Best effort: storage can be full or
  // disabled, and losing the layout is not worth an error.
  useEffect(() => {
    if (knownRef.current === null) return
    try {
      window.localStorage.setItem(stageKey(projectRoot), JSON.stringify(stage))
    } catch {
      // ignore
    }
  }, [stage, projectRoot])

  function notifyAsking(session: ListedSession): void {
    try {
      const note = new Notification(`${session.name} is waiting for you`, {
        body: session.latestWords ?? agentName(session.agent),
        tag: `cw-asked-${session.id}`,
        silent: !hostRef.current.notify.sound,
      })
      note.onclick = () => {
        window.focus()
        hostRef.current.activate()
        focusSessionRef.current(session.id)
      }
    } catch {
      // notifications unavailable: the rail's amber row still says it
    }
  }

  /** The session behind the focused pane of the active tab — what the rail's buttons act on. */
  const focusedId = useMemo(() => {
    const tab = stage.tabs.find((t) => t.id === stage.activeTabId)
    const pane = tab ? findPane(tab.root, tab.focusedPaneId)?.pane : undefined
    return pane && pane.kind !== 'browser' ? pane.sessionId : null
  }, [stage])

  /**
   * Report the open sessions back to the daemon, which owns the journal file. Skipped
   * when unchanged: a `tui.invalidate` arrives after every session mutation.
   */
  useEffect(() => {
    const ids = [...new Set(paneKeys(stage).filter((k) => k.startsWith('session:')).map((k) => k.slice('session:'.length)))]
    const key = ids.join('\n')
    if (ids.length === 0 || lastJournalRef.current === key) return
    lastJournalRef.current = key
    void api.journalSet(ids).catch(() => undefined)
  }, [stage, api])

  const attentionById = useMemo(() => {
    const out: Record<string, AttentionKind> = {}
    for (const session of sessions) {
      out[session.id] = deriveAttention({
        status: session.status ?? '',
        landability: landabilityByName.get(session.name),
      })
    }
    return out
  }, [sessions, landabilityByName])

  // The rail and the Dock read live views from here.
  useEffect(() => {
    hostRef.current.report(projectRoot, { sessions, attentionById, focusedId, colors })
  }, [projectRoot, sessions, attentionById, focusedId, colors])
  useEffect(() => () => hostRef.current.report(projectRoot, null), [projectRoot])

  const focused = sessions.find((session) => session.id === focusedId) ?? null

  /** Show a session: its existing pane if a tab has one, else a new tab. */
  function focusSession(sessionId: string): void {
    setStage((s) => {
      const at = locatePane(s, `session:${sessionId}`)
      if (at) return focusPane(s, at.tabId, at.paneId)
      const name = sessionsRef.current.find((x) => x.id === sessionId)?.name ?? sessionId
      return openInNewTab(s, { kind: 'session', sessionId }, name)
    })
  }
  const focusSessionRef = useRef(focusSession)
  focusSessionRef.current = focusSession

  async function runAction(action: () => Promise<unknown>): Promise<void> {
    const actionError = await runCockpitAction(action, () => load())
    if (!actionError) return
    // With panes on the stage an error is a toast; with none, the stage says it.
    if (stage.tabs.length > 0) hostRef.current.toast(plainErrorMessage(actionError), 'error')
    else {
      setError(actionError)
      setStatus(stageStatusAfterFailure(sessionsRef.current.length))
    }
  }

  function run(action: ViewAction): void {
    if (knownRef.current === null) {
      queuedRef.current.push(action)
      return
    }
    if (action.kind === 'new') void handleNew()
    else if (action.kind === 'create') void createAndOpen(action.name, action.options, action.launcher)
    else if (action.kind === 'land-all') void handleLandAll()
    else rowAction(action.sessionId, action.action)
  }
  const runRef = useRef(run)
  runRef.current = run

  function rowAction(sessionId: string, action: RowAction | 'focus'): void {
    if (action === 'focus') focusSession(sessionId)
    else if (action === 'open') { focusSession(sessionId); void handleStart(sessionId) }
    else if (action === 'stop') void handleStop(sessionId)
    else if (action === 'changes') openChanges(sessionId)
    else if (action === 'land') void handleLand(sessionId)
    else if (action === 'terminal') void openShell(sessionId)
    else if (action === 'delete') void handleDelete(sessionId)
    else void handleKill(sessionId)
  }

  // Menu accelerators meant for the stage arrive here through the host.
  const commandRef = useRef<(command: string) => void>(() => undefined)
  commandRef.current = (command: string) => {
    if (command === 'command-bar') openCommandBar()
    else if (command === 'split-right') splitFocused('row')
    else if (command === 'split-down') splitFocused('column')
    else if (command === 'close-pane') closeFocusedPane()
    else if (command === 'new-agent') void handleNew()
    else if (command === 'jump-attention') jumpToAttention()
    else if (command === 'open-terminal') void handleTerminal()
    else if (command === 'open-file') void handleOpenFile()
    else if (command === 'open-browser') handleOpenBrowser()
  }

  useEffect(() => {
    hostRef.current.register(projectRoot, {
      run: (action) => runRef.current(action),
      command: (name) => commandRef.current(name),
      setColor: (sessionId, color) => {
        setColors((current) => {
          const next = { ...current }
          if (color === null) delete next[sessionId]
          else next[sessionId] = color
          writeColors(projectRoot, next)
          return next
        })
      },
    })
    return () => hostRef.current.register(projectRoot, null)
  }, [projectRoot])

  /** The focused pane of the active tab, for ⌘D / ⌘⇧D / ⌘W. */
  function focusedPaneAt(): { tabId: string; paneId: string; pane: PaneRef } | null {
    const tab = stage.tabs.find((t) => t.id === stage.activeTabId)
    if (!tab) return null
    const found = findPane(tab.root, tab.focusedPaneId)
    return found ? { tabId: tab.id, paneId: tab.focusedPaneId, pane: found.pane } : null
  }

  function splitFocused(dir: SplitDir): void {
    const at = focusedPaneAt()
    if (at && at.pane.kind !== 'browser') void openShell(at.pane.sessionId, { tabId: at.tabId, paneId: at.paneId, dir })
  }

  function closeFocusedPane(): void {
    const at = focusedPaneAt()
    if (at) handleClosePane(at.tabId, at.paneId, at.pane)
  }

  async function handleNew(): Promise<void> {
    // Fetched on open: a CLI installed a minute ago, or a launcher just edited, shows.
    const [branchList, launcherList] = await Promise.all([
      api.listBranches().catch(() => [] as string[]),
      api.listLaunchers().catch(() => [] as LauncherOption[]),
    ])
    setBranches(branchList)
    setLaunchers(launcherList)
    setPickerOpen(true)
  }

  /** A session and its shell, opened at once — running `launcher` in it unless 'terminal'. */
  async function createAndOpen(name: string, options: NewSessionOptions, launcher = 'terminal'): Promise<void> {
    await runAction(async () => {
      const created = await api.newSession({ name, ...options }) as { id?: string }
      if (typeof created?.id !== 'string') return
      await api.resumeSession(created.id, launcher)
      writeString(LAST_LAUNCHER_KEY, launcher)
      await load()
      focusSession(created.id)
    })
  }

  async function handlePickerCreate(request: NewSessionRequest): Promise<void> {
    setPickerOpen(false)
    if (request.projectRoot !== projectRoot) hostRef.current.createElsewhere(request)
    else await createAndOpen(request.name, request.options, request.launcher)
  }

  /** What a stopped session's pane shows under its terminal: a way to reopen its shell. */
  function launchFor(sessionId: string, paneFocused: boolean): preact.JSX.Element | null {
    const session = sessions.find((s) => s.id === sessionId)
    if (!session || session.status !== 'idle') return null
    return (
      <StoppedBar
        key={session.id}
        sessionName={session.name}
        focused={paneFocused}
        onStart={async () => {
          try {
            await api.resumeSession(session.id)
          } catch (err) {
            return plainErrorMessage(err)
          }
          await load()
          return null
        }}
      />
    )
  }

  /** The toggle beside the tabs: the focused session's Changes pane, open or closed. */
  function toggleChanges(): void {
    const target = sessionById(undefined)
    if (!target) return
    const at = locatePane(stage, `changes:${target.id}`)
    if (at) setStage((s) => closePane(s, at.tabId, at.paneId))
    else openChanges(target.id)
  }

  /** The Changes pane for a session: beside the focused pane, or focused if open. */
  function openChanges(targetId?: string): void {
    const target = sessionById(targetId)
    if (!target) return
    const at = locatePane(stage, `changes:${target.id}`)
    if (at) setStage((s) => focusPane(s, at.tabId, at.paneId))
    else openSurface({ kind: 'changes', sessionId: target.id }, `${target.name} · changes`)
  }

  function openCommandBar(): void {
    setCommandBarOpen(true)
    // Launcher names complete in `new <name> <launcher>`; fetched fresh each time.
    void api.listLaunchers().then(setLaunchers).catch(() => undefined)
  }

  /** One parsed command, run; resolves to an error sentence, or null. */
  async function runCommand(command: Command, line: string): Promise<string | null> {
    setCommandHistory((all) => {
      const next = rememberLine(all, line)
      writeStringList(COMMAND_HISTORY_KEY, next)
      return next
    })
    try {
      switch (command.kind) {
        case 'new': {
          setCommandBarOpen(false)
          // No --worktree / --shared: the project's own default (the project folder unless set).
          const defaults = hostRef.current.defaultsFor(projectRoot)
          const worktree = command.worktree ?? defaults.worktree
          const base = command.base ?? (worktree ? defaults.base : undefined)
          await createAndOpen(command.name, { worktree, ...(base === undefined ? {} : { base }) }, command.launcher)
          return null
        }
        case 'start':
          await api.resumeSession(command.session)
          await load()
          focusSession(command.session)
          return null
        case 'stop':
          await api.stopSession(command.session)
          await load()
          return null
        case 'kill':
          setCommandBarOpen(false)
          await handleKill(command.session, command.removeWorktree)
          return null
        case 'land':
          setCommandBarOpen(false)
          await handleLand(command.session)
          return null
        case 'land-all':
          setCommandBarOpen(false)
          await handleLandAll()
          return null
        case 'diff':
          openChanges(command.session)
          return null
        case 'terminal':
          await openShell(command.session)
          return null
        case 'rename':
          await api.renameSession(command.session, command.to)
          await load()
          return null
        case 'open':
          setCommandBarOpen(false)
          if (command.path !== undefined && focusedId !== null) openFilePane(focusedId, command.path)
          else await handleOpenFile()
          return null
        case 'browser':
          handleOpenBrowser(command.url)
          return null
        case 'attention':
          jumpToAttention()
          return null
        case 'settings':
          setCommandBarOpen(false)
          hostRef.current.openSettings()
          return null
        case 'gc':
          await api.collectGarbage(command.force)
          await load()
          return null
        case 'help':
          return null
      }
    } catch (err) {
      return plainErrorMessage(err)
    }
  }

  function jumpToAttention(): void {
    const target = nextAttentionSession(sessions, attentionById, focusedId)
    if (target !== null) focusSession(target)
  }

  function sessionById(id: string | undefined): ListedSession | null {
    return sessions.find((s) => s.id === (id ?? focusedId)) ?? null
  }

  async function handleStart(targetId?: string): Promise<void> {
    const target = sessionById(targetId)
    if (!target) return
    // The pane re-attaches from load(): the session's move to `running` is detected
    // there, the same way as when the CLI or another window starts it.
    await runAction(() => api.resumeSession(target.id))
  }

  /** A shell for `sessionId`, split beside `at` (or in a tab of its own). */
  async function openShell(sessionId: string, at?: { tabId: string; paneId: string; dir: SplitDir }): Promise<void> {
    await runAction(async () => {
      const opened = await api.openTerminal(sessionId)
      const pane: PaneRef = { kind: 'terminal', terminalId: opened.terminalId, sessionId }
      setStage((s) => {
        // A load that raced this call may have opened it already.
        const existing = locatePane(s, `terminal:${opened.terminalId}`)
        if (existing) return focusPane(s, existing.tabId, existing.paneId)
        // The pane bar's split buttons say exactly where; a shortcut uses placeBeside.
        if (at) return splitPane(s, at.tabId, at.paneId, at.dir, pane)
        return placeBeside(s, pane, `${opened.sessionName} · shell`)
      })
    })
  }

  /** A file or browser pane: beside the focused pane, or in a tab of its own. */
  function openSurface(pane: PaneRef, title: string): void {
    setStage((s) => placeBeside(s, pane, title))
  }

  function openFilePane(sessionId: string, path: string): void {
    const at = locatePane(stage, `file:${sessionId}:${path}`)
    if (at) setStage((s) => focusPane(s, at.tabId, at.paneId))
    else openSurface({ kind: 'file', sessionId, path }, path.split('/').pop() ?? path)
  }

  async function handleOpenFile(targetId?: string): Promise<void> {
    const target = sessionById(targetId)
    if (!target) return
    await runAction(async () => {
      const files = await api.listFiles(target.id)
      setQuickOpen({ sessionId: target.id, name: target.name, files })
    })
  }

  function handleOpenBrowser(url?: string): void {
    // A running session's leased port is where its dev server listens by convention.
    const port = focused?.portBase
    const initial = url ?? (port === undefined ? '' : `http://localhost:${port}/`)
    openSurface({ kind: 'browser', url: initial }, 'browser')
  }

  async function handleTerminal(targetId?: string): Promise<void> {
    const target = sessionById(targetId)
    if (!target) return
    await openShell(target.id)
  }

  function handleClosePane(tabId: string, paneId: string, pane: PaneRef): void {
    // Closing an extra shell's pane ends it; closing a session's pane only hides it.
    if (pane.kind === 'terminal') void api.closeTerminal(pane.terminalId).catch(() => undefined)
    setStage((s) => closePane(s, tabId, paneId))
  }

  async function saveLayouts(next: Record<string, SavedLayout>): Promise<void> {
    setLayouts(next)
    try {
      const current = await api.getSettings() as Record<string, unknown>
      await api.setSettings({ ...current, layouts: next })
    } catch (err) {
      hostRef.current.toast(plainErrorMessage(err), 'error')
    }
  }

  async function handleStop(targetId?: string): Promise<void> {
    const target = sessionById(targetId)
    if (!target) return
    await runAction(() => api.stopSession(target.id))
  }

  async function handleKill(targetId?: string, removeWorktree = false): Promise<void> {
    const target = sessionById(targetId)
    if (!target) return
    const ok = await hostRef.current.askConfirm({
      title: `Kill ${target.name}?`,
      body: removeWorktree
        ? 'Its shell (and whatever runs in it) ends, and its worktree and branch are deleted. Unlanded work is lost.'
        : 'Its shell (and whatever runs in it) ends and the session cannot be reopened. Its worktree stays, so its work can still be landed.',
      confirmLabel: removeWorktree ? 'Kill and delete' : 'Kill',
      danger: true,
    })
    if (!ok) return
    await runAction(() => api.killSession(target.id, removeWorktree))
  }

  /**
   * Out of the rail for good: a live session is killed first (the daemon refuses to
   * remove one that runs), then its row, worktree and branch go. A session in the
   * project folder only loses its row — the folder is the project's.
   */
  async function handleDelete(targetId?: string): Promise<void> {
    const target = sessionById(targetId)
    if (!target) return
    const shared = target.branch === null || target.worktreePath === projectRoot
    const ok = await hostRef.current.askConfirm({
      title: `Delete ${target.name}?`,
      body: shared
        ? 'Its shell (and whatever runs in it) ends and the session leaves the rail. It works in the project folder, which stays exactly as it is.'
        : 'Its shell (and whatever runs in it) ends, and its worktree and branch are deleted. Work that was not landed is lost.',
      confirmLabel: 'Delete',
      danger: true,
    })
    if (!ok) return
    await runAction(async () => {
      if (target.status !== 'dead' && target.status !== 'landed') await api.killSession(target.id, false)
      await api.removeSession(target.id)
    })
    hostRef.current.toast(`Deleted ${target.name}`)
  }

  function landDeps() {
    return {
      getStatus: async () => parseConvergeStatus(await api.convergeStatus()),
      land: async (name: string): Promise<LandResult> => (await api.landSession(name)) as LandResult,
    }
  }

  async function handleLand(targetId?: string): Promise<void> {
    const target = sessionById(targetId)
    if (!target || landBusy) return
    setLandBusy(true)
    const toast = hostRef.current.toast
    try {
      const deps = landDeps()
      let result = await landSelected({ ...deps, name: target.name })
      if (result.status === 'needs_confirm_unknown') {
        const reason = converge.unknown.find((entry) => entry.name === target.name)?.reason ?? 'incomplete evidence'
        const ok = await hostRef.current.askConfirm({
          title: `Land ${target.name} with incomplete evidence?`,
          body: reason,
          confirmLabel: 'Land anyway',
        })
        if (!ok) return
        result = await landSelected({ ...deps, name: target.name, forceUnknown: true })
      }
      if (result.status === 'blocked') {
        const reason = converge.blocked.find((entry) => entry.name === target.name)?.reason
        toast(reason ? `blocked: ${reason}` : `blocked: ${target.name}`)
        return
      }
      if (result.status === 'failed') {
        toast(result.error)
        return
      }
      toast(`landed ${target.name}`)
      await load()
    } catch (err) {
      toast(plainErrorMessage(err))
    } finally {
      setLandBusy(false)
    }
  }

  /** Every ready session of this project, in order. */
  async function handleLandAll(): Promise<void> {
    if (landBusy) return
    const toast = hostRef.current.toast
    setLandBusy(true)
    toast('landing ready sessions…')
    try {
      const landedSoFar: string[] = []
      const result = await landAllReady({
        ...landDeps(),
        onProgress: (name) => {
          landedSoFar.push(name)
          toast(`landed ${landedSoFar.join(', ')}`)
        },
      })
      if (result.failedAt) {
        toast(`landed ${result.landed.join(', ') || '(none)'}; stopped at ${result.failedAt}: ${result.error ?? 'failed'}`)
      } else if (result.landed.length === 0) {
        const unknown = converge.unknown[0]
        toast(unknown ? `nothing to land: ${unknown.reason}` : 'nothing to land')
      } else {
        toast(`landed ${result.landed.join(', ')}`)
      }
      await load()
    } catch (err) {
      toast(plainErrorMessage(err))
    } finally {
      setLandBusy(false)
    }
  }

  return (
    <ProjectApiContext.Provider value={api}>
      <div class="cockpit-view" hidden={!visible} aria-hidden={!visible}>
        {visible && commandBarOpen ? (
          <CommandBar
            context={{
              sessions: sessions.map((s) => ({ id: s.id, name: s.name, ...(s.status === undefined ? {} : { status: s.status }) })),
              focusedName: focused?.name ?? null,
              launchers: launchers.filter((l) => l.enabled && l.available).map((l) => l.id),
            }}
            history={commandHistory}
            onRun={runCommand}
            onClose={() => setCommandBarOpen(false)}
          />
        ) : null}
        {visible && pickerOpen ? (
          <QuickPicker
            projects={host.projects}
            activeRoot={projectRoot}
            takenNames={sessions.map((s) => s.name)}
            branches={branches}
            launchers={launchers}
            lastLauncher={readString(LAST_LAUNCHER_KEY)}
            defaultsFor={host.defaultsFor}
            onCreate={(request) => {
              void handlePickerCreate(request)
            }}
            onCancel={() => setPickerOpen(false)}
          />
        ) : null}
        {visible && quickOpen !== null ? (
          <QuickOpen
            sessionName={quickOpen.name}
            files={quickOpen.files}
            onOpen={(path) => {
              const { sessionId } = quickOpen
              setQuickOpen(null)
              openFilePane(sessionId, path)
            }}
            onCancel={() => setQuickOpen(null)}
          />
        ) : null}
        <Stage
          stage={stage}
          sessions={sessions}
          status={status}
          error={error}
          shown={visible}
          launchFor={launchFor}
          onRetry={() => {
            setStatus('loading')
            void load()
          }}
          paneAttachEpoch={paneAttachEpoch}
          paneAttachBumps={paneAttachBumps}
          onActivateTab={(tabId) => setStage((s) => ({ ...s, activeTabId: tabId }))}
          onFocusPane={(tabId, paneId) => setStage((s) => focusPane(s, tabId, paneId))}
          onClosePane={handleClosePane}
          onSplit={(tabId, paneId, dir, pane) => {
            if (pane.kind !== 'browser') void openShell(pane.sessionId, { tabId, paneId, dir })
          }}
          onResize={(tabId, splitId, index, delta) => setStage((s) => resizeSplit(s, tabId, splitId, index, delta))}
          onMoveTab={(tabId, toIndex) => setStage((s) => moveTab(s, tabId, toIndex))}
          onPinTab={(tabId, pinned) => setStage((s) => setPinned(s, tabId, pinned))}
          onCloseTab={(tabId) => setStage((s) => closeTab(s, tabId))}
          onCloseOthers={(tabId) => setStage((s) => closeOthers(s, tabId))}
          onCloseToRight={(tabId) => setStage((s) => closeToRight(s, tabId))}
          colorById={colors}
          inApp={(sessionId, path) => openFilePane(sessionId, path)}
          renderSurface={(pane, paneFocused, at) => {
            if (pane.kind === 'changes') {
              const session = sessions.find((s) => s.id === pane.sessionId)
              if (!session) return null
              const namesByBranch = new Map(sessions.flatMap((s) => (s.branch ? [[s.branch, s.name] as const] : [])))
              return (
                <ChangesPane
                  sessionName={session.name}
                  verdict={landVerdict(session, converge, convergeDetail, namesByBranch)}
                  revision={sessionsRevision}
                  loadDiff={() => api.sessionDiff(session.id)}
                  onLand={() => void handleLand(session.id)}
                  landBusy={landBusy}
                  shared={session.branch === null || session.worktreePath === projectRoot}
                />
              )
            }
            if (pane.kind === 'file') return <FilePane sessionId={pane.sessionId} path={pane.path} focused={paneFocused} />
            if (pane.kind === 'browser') {
              return (
                <BrowserPane
                  url={pane.url}
                  onNavigate={(url) => setStage((s) => replacePane(s, at.tabId, at.paneId, { kind: 'browser', url }))}
                />
              )
            }
            return null
          }}
          layouts={Object.keys(layouts).sort()}
          onSaveLayout={(name) => {
            const saved = toSavedLayout(stage, new Map(sessions.map((s) => [s.id, s.name])))
            void saveLayouts({ ...layouts, [name]: saved })
          }}
          onApplyLayout={(name) => {
            const saved = layouts[name]
            if (saved) setStage(fromSavedLayout(saved, new Map(sessions.map((s) => [s.name, s.id]))))
          }}
          onDeleteLayout={(name) => {
            const next = { ...layouts }
            delete next[name]
            void saveLayouts(next)
          }}
          sidebarHidden={host.sidebarHidden}
          onToggleSidebar={host.onToggleSidebar}
          onNewTab={() => { void handleNew() }}
          onToggleChanges={toggleChanges}
          changesOpen={focusedId !== null && Boolean(locatePane(stage, `changes:${focusedId}`))}
        />
      </div>
    </ProjectApiContext.Provider>
  )
}
