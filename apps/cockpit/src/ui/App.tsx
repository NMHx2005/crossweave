import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { UpdateNotice } from './UpdateNotice'
import { cockpitApi, projectApi, type LauncherOption, type ListedSession, type ProjectSnapshot } from '../host/cockpit-api'
import { ConfirmDialog, type ConfirmRequest } from './ConfirmDialog'
import { OpenFolderDialog } from './OpenFolderDialog'
import type { FolderInfo } from '../../electron/folder-open'
import type { NewSessionRequest } from './QuickPicker'
import { SettingsPage, type NotifyPrefs, type UserSettings } from './SettingsPage'
import { ProjectSettings } from './ProjectSettings'
import { moveProject, projectLabel, readPrefs, withPrefs, writePrefs, type PrefsMap, type ProjectPrefs } from '../lib/project-prefs'
import { suggestSessionName } from '../lib/quick-picker'
import { deriveAttention, parseLandabilityByName, type AttentionKind } from '../lib/attention'
import { plainErrorMessage } from '../lib/cockpit-host'
import { Sidebar, type FolderHow, type ProjectAction, type ProjectGroup, type Renaming, type RowAction } from './Sidebar'
import { jumpTargets } from '../lib/rail'
import { mountedViews, touchRecent } from '../lib/mounted-views'
import { ProjectView, type ViewAction, type ViewHandle, type ViewHost, type ViewReport } from './ProjectView'
import { baseName, readFlag, readString, writeFlag, writeString } from './storage'
import { PaneThemeContext, TerminalLookContext } from './terminal-look-context'
import { applyTheme, resolveTheme, xtermThemeFor, type ResolvedTheme } from './themes'
import { ShortcutsDialog } from './ShortcutsPanel'
import { COMMANDS, effectiveKeys, formatAccelerator, keyMatchesAccelerator, menuLessBindings } from '../lib/keymap'
import { buildTable, initialKeyTable, isTerminalFocus, keyTableStep, prefixLiteral, PREFIX_TIMEOUT_MS, type KeyTableState } from '../lib/keytable'
import { KeyTableHint } from './KeyTableHint'
import { SessionHistoryDialog } from './SessionHistoryDialog'
import type { InterfaceAppearance, TerminalAppearance, UsageSettings } from '../../../../src/core/settings.js'
import { applyAppearance } from '../lib/appearance'

const SIDEBAR_HIDDEN_KEY = 'cw.sidebar-hidden.v1'
/** Notification choices ('0' off; on unless turned off). */
const NOTIFY_SOUND_KEY = 'cw.notify-sound.v1' // gitleaks:allow (a localStorage key name, not a secret)
const DOCK_BADGE_KEY = 'cw.dock-badge.v1' // gitleaks:allow (a localStorage key name, not a secret)
const NOTIFY_FINISH_KEY = 'cw.notify-finish.v1' // gitleaks:allow (a localStorage key name, not a secret)
/**
 * How many projects keep their panes alive in the window. Each live terminal keeps its
 * scrollback; past this, the project shown longest ago lets go of its panes (its
 * shells keep running in its daemon) and re-attaches when shown again.
 */
const LIVE_VIEWS = 6

/** Row actions that need the project on the stage; the others run where it is. */
const NEEDS_STAGE = new Set<RowAction | 'focus'>(['focus', 'open', 'terminal', 'changes', 'debug'])

/**
 * The window: the rail, the dialogs and toasts every project shares, and one live
 * ProjectView per recently shown project. Switching project shows another view — it
 * does not reload the window, and the project left keeps its panes streaming.
 */
export function App() {
  const [openRoots, setOpenRoots] = useState<string[]>([])
  const [activeRoot, setActiveRoot] = useState<string | null>(null)
  const [booted, setBooted] = useState(false)
  /** Projects most recently shown first: which views stay mounted. */
  const [recent, setRecent] = useState<string[]>([])
  /** Live views' state, by project; projects without a view use snapshots. */
  const [reports, setReports] = useState<Record<string, ViewReport>>({})
  const reportsRef = useRef(reports)
  reportsRef.current = reports
  const [snapshots, setSnapshots] = useState<Record<string, ProjectSnapshot>>({})
  const [prefs, setPrefs] = useState<PrefsMap>(readPrefs)
  const [railQuery, setRailQuery] = useState('')
  const [renaming, setRenaming] = useState<Renaming | null>(null)
  const [sidebarHidden, setSidebarHidden] = useState<boolean>(() => readFlag(SIDEBAR_HIDDEN_KEY))
  /** The clock the rail's "2m ago" reads; ticks so the times move without a reload. */
  const [now, setNow] = useState(() => Date.now())
  const [confirmState, setConfirmState] = useState<(ConfirmRequest & { resolve: (ok: boolean) => void }) | null>(null)
  const [toast, setToast] = useState<{ message: string; tone: 'info' | 'error' } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState<{
    settings: UserSettings
    availability: Record<string, boolean>
    defaults: Record<string, { label: string; command: string }>
    importSources: { ghostty: boolean; iterm2: boolean }
    /** The section to open on (a deep link). */
    section?: string
  } | null>(null)
  const [projectSettings, setProjectSettings] = useState<{ projectRoot: string; launchers: LauncherOption[]; branches: string[] } | null>(null)
  const [notify, setNotify] = useState<NotifyPrefs>(() => ({
    sound: readString(NOTIFY_SOUND_KEY) !== '0',
    dockBadge: readString(DOCK_BADGE_KEY) !== '0',
    finish: readString(NOTIFY_FINISH_KEY) !== '0',
  }))
  /** Settings → Terminal, applied to every pane; undefined is the cockpit's own look. */
  const [terminalLook, setTerminalLook] = useState<TerminalAppearance | undefined>(undefined)
  /** Settings → Appearance as saved; a preview while Settings is open may differ until Save or Cancel. */
  const [appearance, setAppearance] = useState<InterfaceAppearance | undefined>(undefined)
  useEffect(() => applyAppearance(appearance), [appearance])
  /** macOS's appearance, for the System theme; followed live. */
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true)
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!query) return
    const on = (e: MediaQueryListEvent): void => setSystemDark(e.matches)
    query.addEventListener('change', on)
    return () => query.removeEventListener('change', on)
  }, [])
  // What Cancel returns to — updated by Save before the dialog closes in the same tick.
  const savedAppearance = useRef(appearance)
  savedAppearance.current = appearance
  const loadFonts = useCallback(() => cockpitApi.listFonts(), [])
  /** Settings → Usage: the rail's token / cost figures and the user's prices. */
  const [usageSettings, setUsageSettings] = useState<UsageSettings | undefined>(undefined)
  /** Settings → Keyboard, for Help → Keyboard Shortcuts. */
  const [keybindings, setKeybindings] = useState<Record<string, string | null> | undefined>(undefined)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [sessionHistoryOpen, setSessionHistoryOpen] = useState(false)
  const lookLoaded = useRef(false)
  /** Read once, through the first project a daemon answers for (Settings are per user). */
  const loadLook = useCallback((root: string): void => {
    if (lookLoaded.current) return
    lookLoaded.current = true
    void projectApi(root).getSettings()
      .then((s) => {
        const saved = s as { terminal?: TerminalAppearance; appearance?: InterfaceAppearance; usage?: UsageSettings; keybindings?: Record<string, string | null> } | null
        setTerminalLook(saved?.terminal)
        setAppearance(saved?.appearance)
        setUsageSettings(saved?.usage)
        setKeybindings(saved?.keybindings)
      })
      .catch(() => { lookLoaded.current = false })
  }, [])
  const theme: ResolvedTheme = useMemo(
    () => resolveTheme(appearance?.theme, terminalLook?.colors, systemDark),
    [appearance?.theme, terminalLook?.colors, systemDark],
  )
  useEffect(() => applyTheme(theme), [theme])
  const paneTheme = useMemo(() => ({ colors: theme.colors, xterm: xtermThemeFor(theme) }), [theme])
  const handles = useRef(new Map<string, ViewHandle>())
  /** Actions for a view that is not mounted (or has not registered) yet. */
  const pending = useRef(new Map<string, ViewAction[]>())
  const activeRef = useRef(activeRoot)
  activeRef.current = activeRoot

  const mounted = useMemo(() => mountedViews(recent, activeRoot, openRoots, LIVE_VIEWS), [recent, activeRoot, openRoots])

  const showToast = useCallback((message: string, tone: 'info' | 'error' = 'info') => setToast({ message, tone }), [])

  /** Every open project, and a snapshot of each one without a live view. */
  const refreshProjects = useCallback(async (only?: string): Promise<void> => {
    try {
      const { open, plain } = await cockpitApi.listProjects()
      setOpenRoots(open)
      setPlainRoots(plain ?? [])
      const wanted = open.filter((root) => !reportsRef.current[root] && (only === undefined || root === only))
      const fetched = await Promise.all(wanted.map((root) => cockpitApi.projectSessions(root).catch(() => null)))
      setSnapshots((prev) => {
        const next: Record<string, ProjectSnapshot> = {}
        for (const root of open) if (prev[root]) next[root] = prev[root] as ProjectSnapshot
        for (const snap of fetched) if (snap) next[snap.projectRoot] = snap
        return next
      })
    } catch {
      // the rail keeps what it had
    }
  }, [])

  function show(root: string): void {
    setOpenRoots((open) => (open.includes(root) ? open : [...open, root]))
    setActiveRoot(root)
    setRecent((r) => touchRecent(r, root))
  }

  // Boot: the project the bridge has on the stage (main attached it from argv or the
  // last session), else the welcome.
  useEffect(() => {
    void (async () => {
      let active: string | undefined
      try {
        active = (await cockpitApi.listProjects()).active
      } catch {
        active = undefined
      }
      if (active === undefined) {
        try {
          active = (await cockpitApi.ensureWorkspace()).projectRoot
        } catch (err) {
          // Opened from the Dock with no project yet: the welcome, not an error.
          if (!String(err).includes('NO_PROJECT')) showToast(plainErrorMessage(err), 'error')
        }
      }
      if (active !== undefined) {
        show(active)
        loadLook(active)
      }
      await refreshProjects()
      setBooted(true)
    })()
  }, [refreshProjects, showToast, loadLook])

  useEffect(() => {
    // A project without a live view refreshes its rail snapshot; live views refresh themselves.
    const unsub = cockpitApi.onProjectInvalidate((root) => {
      if (!reportsRef.current[root]) void refreshProjects(root)
    })
    const tick = setInterval(() => setNow(Date.now()), 15_000)
    return () => {
      unsub()
      clearInterval(tick)
    }
  }, [refreshProjects])

  // The Dock counts the sessions waiting for you, in every open project. Sent only on a
  // change: this runs on every report.
  const badgeRef = useRef(-1)
  useEffect(() => {
    const all: ListedSession[] = [
      ...Object.values(reports).flatMap((r) => r.sessions),
      ...Object.entries(snapshots).filter(([root]) => !reports[root]).flatMap(([, snap]) => snap.sessions),
    ]
    const count = notify.dockBadge
      ? all.filter((s) => s.activity === 'asked' && (s.status === 'running' || s.status === 'waiting')).length
      : 0
    if (badgeRef.current === count) return
    badgeRef.current = count
    void cockpitApi.setBadge(count).catch(() => undefined)
  }, [reports, snapshots, notify.dockBadge])

  /** Hand `action` to `root`'s view now if it is live, or once it has mounted and loaded. */
  function enqueue(root: string, action: ViewAction): void {
    const handle = handles.current.get(root)
    if (handle) {
      handle.run(action)
      return
    }
    pending.current.set(root, [...(pending.current.get(root) ?? []), action])
  }

  /**
   * Put `root` on the stage: the bridge makes it the default project (and remembers it
   * for the next launch), and its view is shown — mounted first if it has none. No
   * reload: every other view keeps its panes.
   */
  async function activate(root: string, then?: ViewAction): Promise<void> {
    if (root !== activeRef.current) {
      // A folder not open yet is looked at first: only a repository's top level can
      // have a daemon; anything else gets the Open folder dialog instead of a timeout.
      if (!openRoots.includes(root)) {
        const info = await cockpitApi.inspectFolder(root).catch(() => null)
        if (info !== null && info.kind !== 'repo' && info.plainChosen !== true) {
          setFolderDialog({ path: root, info })
          return
        }
      }
      try {
        await cockpitApi.ensureWorkspace(root)
      } catch (err) {
        showToast(plainErrorMessage(err), 'error')
        return
      }
      show(root)
      loadLook(root)
      if (!openRoots.includes(root)) void refreshProjects()
    }
    if (then) enqueue(root, then)
  }

  // Listeners registered once call the current activate (it reads this render's state).
  const activateRef = useRef(activate)
  activateRef.current = activate

  /** Run `action` in `root`'s view without putting it on the stage (it stays or becomes live). */
  function runIn(root: string, action: ViewAction): void {
    if (root === activeRef.current) {
      enqueue(root, action)
      return
    }
    setRecent((r) => (r.includes(root) ? r : [...r.slice(0, 1), root, ...r.slice(1)]))
    enqueue(root, action)
  }

  function onRailAction(root: string, sessionId: string, action: RowAction | 'focus'): void {
    const act: ViewAction = { kind: 'row', sessionId, action }
    if (NEEDS_STAGE.has(action)) void activate(root, act)
    else runIn(root, act)
  }

  function labelOf(root: string): string {
    return projectLabel(prefs[root], snapshots[root]?.name ?? baseName(root))
  }

  function updatePrefs(root: string, patch: Partial<Record<keyof ProjectPrefs, unknown>>): void {
    setPrefs((current) => {
      const next = withPrefs(current, root, patch)
      writePrefs(next)
      return next
    })
  }

  /** What a new session in `root` starts as, unless the picker or a flag says otherwise. */
  const defaultsFor = (root: string): { launcher?: string; worktree: boolean; base?: string; plain?: boolean } => {
    const p = prefs[root]
    // A plain folder has no worktrees: its sessions can only run in the folder.
    if (plainRoots.includes(root)) return { worktree: false, plain: true, ...(p?.launcher === undefined ? {} : { launcher: p.launcher }) }
    return {
      worktree: p?.worktree === true,
      ...(p?.launcher === undefined ? {} : { launcher: p.launcher }),
      ...(p?.base === undefined ? {} : { base: p.base }),
    }
  }

  function sessionsOf(root: string): ListedSession[] {
    return reports[root]?.sessions ?? snapshots[root]?.sessions ?? []
  }

  async function openProject(): Promise<void> {
    const root = await cockpitApi.pickProject().catch(() => null)
    if (root !== null) await activate(root)
  }

  /**
   * Out of the rail — its daemon and sessions keep running, and opening the folder
   * again brings them back. Closing the one on the stage shows the next open project,
   * or the welcome when it was the last.
   */
  async function closeProject(root: string): Promise<void> {
    try {
      await cockpitApi.closeProject(root)
    } catch (err) {
      showToast(plainErrorMessage(err), 'error')
      return
    }
    const rest = openRoots.filter((r) => r !== root)
    setOpenRoots(rest)
    setRecent((r) => r.filter((x) => x !== root))
    pending.current.delete(root)
    if (root === activeRef.current) {
      const next = rest[0]
      if (next !== undefined) await activate(next)
      else setActiveRoot(null)
    } else {
      showToast(`Closed ${labelOf(root)} — its sessions keep running`)
    }
    await refreshProjects()
  }

  async function reorderProjects(next: string[]): Promise<void> {
    setOpenRoots(next)
    try {
      await cockpitApi.reorderProjects(next)
    } catch (err) {
      showToast(plainErrorMessage(err), 'error')
      await refreshProjects()
    }
  }

  function onProjectAction(root: string, action: ProjectAction): void {
    switch (action) {
      case 'new': void activate(root, { kind: 'new' }); return
      case 'terminal-here': {
        // A Terminal session in the project folder itself (no worktree), opened at once.
        const name = suggestSessionName('shell', sessionsOf(root).map((s) => s.name))
        void activate(root, { kind: 'create', name, options: { worktree: false }, launcher: 'terminal' })
        return
      }
      case 'land-all': runIn(root, { kind: 'land-all' }); return
      case 'gc': void cleanUp(root); return
      case 'toggle-ended': updatePrefs(root, { hideEnded: prefs[root]?.hideEnded === true ? undefined : true }); return
      case 'settings': void openProjectSettings(root); return
      case 'close': void closeProject(root); return
      case 'move-up': void reorderProjects(moveProject(openRoots, root, -1)); return
      case 'move-down': void reorderProjects(moveProject(openRoots, root, 1)); return
    }
  }

  /** Open projects that are plain folders (no git): no worktrees, Land or branches. */
  const [plainRoots, setPlainRoots] = useState<string[]>([])

  async function openPlain(path: string): Promise<void> {
    const r = await cockpitApi.openPlainFolder(path).catch(() => ({ ok: false }))
    if (!r.ok) {
      showToast('That folder cannot be opened as a plain folder', 'error')
      return
    }
    setFolderDialog(null)
    setPlainRoots((list) => (list.includes(path) ? list : [...list, path]))
    await activate(path)
  }

  /** A folder chosen to open that is not a repository's top level (OpenFolderDialog). */
  const [folderDialog, setFolderDialog] = useState<{ path: string; info: FolderInfo } | null>(null)

  async function initGitIn(path: string): Promise<string | null> {
    const ok = await askConfirm({
      title: `Initialize git in “${baseName(path)}”?`,
      body: 'Runs git init there — and an empty first commit when your git name and email are set. Nothing else in the folder changes.',
      confirmLabel: 'Initialize git',
    })
    if (!ok) return null
    const result = await cockpitApi.initGit(path).catch((err: unknown) => ({ ok: false, committed: false, message: plainErrorMessage(err) }))
    if (!result.ok) return result.message
    // A repository now: open it like any other.
    setFolderDialog(null)
    showToast(result.message, 'info')
    await activate(path)
    return result.message
  }

  /** Resolves to the user's answer; only one confirmation is ever open. */
  function askConfirm(request: ConfirmRequest): Promise<boolean> {
    return new Promise((resolve) => setConfirmState({ ...request, resolve }))
  }

  async function cleanUp(root: string): Promise<void> {
    const label = labelOf(root)
    const ok = await askConfirm({
      title: `Clean up ended sessions in ${label}?`,
      body: 'Deletes the worktrees and branches of sessions that were landed, and of killed ones with nothing left to land. A killed session still holding unlanded work is kept.',
      confirmLabel: 'Clean up',
    })
    if (!ok) return
    try {
      const result = await projectApi(root).collectGarbage(false)
      const removed = result?.removed?.length ?? 0
      const kept = result?.kept?.length ?? 0
      showToast(`${label}: cleaned up ${removed === 0 ? 'nothing' : `${removed} worktree${removed === 1 ? '' : 's'}`}${kept > 0 ? `; kept ${kept} with unlanded work` : ''}`)
    } catch (err) {
      showToast(plainErrorMessage(err), 'error')
    }
  }

  async function openProjectSettings(root: string): Promise<void> {
    const api = projectApi(root)
    const [launcherList, branchList] = await Promise.all([
      api.listLaunchers().catch(() => [] as LauncherOption[]),
      api.listBranches().catch(() => [] as string[]),
    ])
    setProjectSettings({ projectRoot: root, launchers: launcherList, branches: branchList })
  }

  /** Renamed in place, in whichever open project it lives; its view refreshes on the daemon's word. */
  async function renameSessionIn(root: string, sessionId: string, name: string): Promise<string | null> {
    try {
      await projectApi(root).renameSession(sessionId, name)
    } catch (err) {
      return plainErrorMessage(err)
    }
    if (!reportsRef.current[root]) await refreshProjects(root)
    return null
  }

  /** A session's note, in whichever open project it lives; its view refreshes on the daemon's word. */
  async function setNoteIn(root: string, sessionId: string, note: string): Promise<string | null> {
    try {
      await projectApi(root).setNote(sessionId, note)
    } catch (err) {
      return plainErrorMessage(err)
    }
    if (!reportsRef.current[root]) await refreshProjects(root)
    return null
  }

  async function onFolder(root: string, sessionId: string | null, how: FolderHow): Promise<void> {
    if (how === 'copy') {
      const path = sessionId === null ? root : sessionsOf(root).find((s) => s.id === sessionId)?.worktreePath
      if (typeof path !== 'string') return
      try {
        await navigator.clipboard.writeText(path)
        showToast(`Copied ${path}`)
      } catch {
        showToast('Could not reach the clipboard', 'error')
      }
      return
    }
    const id = sessionId ?? undefined
    const result = await (how === 'reveal' ? cockpitApi.revealFolder(root, id) : cockpitApi.openFolderInEditor(root, id))
      .catch(() => ({ ok: false }))
    if (!result.ok) showToast(how === 'reveal' ? 'That folder is gone' : 'Could not open the editor — check Settings (⌘,)', 'error')
  }

  function onReorder(from: string, to: string): void {
    const at = openRoots.indexOf(to)
    if (at < 0 || !openRoots.includes(from)) return
    void reorderProjects(moveProject(openRoots, from, at - openRoots.indexOf(from)))
  }

  function toggleSidebar(): void {
    setSidebarHidden((hidden) => {
      writeFlag(SIDEBAR_HIDDEN_KEY, !hidden)
      return !hidden
    })
  }

  async function handleOpenSettings(section?: string): Promise<void> {
    // Settings are the user's (~/.crossweave), read through any project's daemon.
    const root = activeRef.current ?? openRoots[0]
    if (root === undefined) {
      showToast('Open a project first — Settings are read through its daemon', 'error')
      return
    }
    try {
      const api = projectApi(root)
      const [settings, launcherList, importSources] = await Promise.all([
        api.getSettings(),
        api.listLaunchers(),
        cockpitApi.terminalImportSources().catch(() => ({ ghostty: false, iterm2: false })),
      ])
      const availability: Record<string, boolean> = {}
      const defaults: Record<string, { label: string; command: string }> = {}
      for (const l of launcherList) {
        availability[l.id] = l.available
        if (l.defaults) defaults[l.id] = l.defaults
      }
      setSettingsOpen({ settings: settings as UserSettings, availability, defaults, importSources, ...(section === undefined ? {} : { section }) })
    } catch (err) {
      showToast(plainErrorMessage(err), 'error')
    }
  }

  /** Save through the daemon, which validates; its refusal is shown in the form. */
  async function saveSettings(next: UserSettings): Promise<string | null> {
    const root = activeRef.current ?? openRoots[0]
    if (root === undefined) return 'Open a project first'
    try {
      const saved = await projectApi(root).setSettings(next) as { terminal?: TerminalAppearance; appearance?: InterfaceAppearance; usage?: UsageSettings; keybindings?: Record<string, string | null> }
      setTerminalLook(saved?.terminal)
      setUsageSettings(saved?.usage)
      setKeybindings(saved?.keybindings)
      // The menu owns the accelerators: rebuild it from the file just written.
      void cockpitApi.refreshMenu().catch(() => undefined)
      setAppearance(saved?.appearance)
      savedAppearance.current = saved?.appearance
      // Unchanged state does not re-run the effect; the preview may still be showing.
      applyAppearance(saved?.appearance)
      return null
    } catch (err) {
      // Only the daemon's sentence: not the IPC wrapper or the error class in front of it.
      return plainErrorMessage(err)
    }
  }

  /** The rail: every open project — live views as they are, the others from snapshots. */
  function railGroups(): ProjectGroup[] {
    const groups: ProjectGroup[] = []
    for (const root of openRoots) {
      const p = prefs[root]
      const view = {
        ...(p?.color === undefined ? {} : { color: p.color }),
        ...(p?.hideEnded === true ? { hideEnded: true } : {}),
      }
      const active = root === activeRoot
      const live = reports[root]
      if (live) {
        groups.push({ projectRoot: root, name: projectLabel(p, baseName(root)), active, sessions: live.sessions, attentionById: live.attentionById, doneIds: live.doneIds, ...view, ...(plainRoots.includes(root) ? { plain: true } : {}) })
        continue
      }
      const snap = snapshots[root]
      if (!snap) {
        groups.push({ projectRoot: root, name: projectLabel(p, baseName(root)), active, sessions: [], attentionById: {}, ...view, ...(plainRoots.includes(root) ? { plain: true } : {}) })
        continue
      }
      const landability = parseLandabilityByName(snap.converge)
      const attention: Record<string, AttentionKind> = {}
      for (const session of snap.sessions) {
        attention[session.id] = deriveAttention({ status: session.status ?? '', landability: landability.get(session.name) })
      }
      groups.push({ projectRoot: root, name: projectLabel(p, snap.name), active, sessions: snap.sessions, attentionById: attention, ...view, ...(plainRoots.includes(root) ? { plain: true } : {}) })
    }
    return groups
  }

  function jumpTo(n: number): void {
    const target = jumpTargets(railGroups(), railQuery)[n - 1]
    if (target) onRailAction(target.projectRoot, target.sessionId, 'focus')
  }

  // Menu accelerators arrive from the main process. The window's own are handled here;
  // the rest belong to the project on the stage.
  const commandRef = useRef<(command: string) => void>(() => undefined)
  commandRef.current = (command: string) => {
    if (command === 'toggle-sidebar') toggleSidebar()
    else if (command === 'open-project') void openProject()
    else if (command === 'open-settings') void handleOpenSettings()
    else if (command === 'show-shortcuts') setShortcutsOpen(true)
    else if (command === 'show-session-history') setSessionHistoryOpen(true)
    else if (/^jump-[1-9]$/.test(command)) jumpTo(Number(command.slice('jump-'.length)))
    else if (activeRef.current === null) {
      if (command === 'new-agent') void openProject()
    } else handles.current.get(activeRef.current)?.command(command)
  }
  // Commands with no menu item have no menu accelerator, so the window listens for the user's
  // own binding (capture, so a focused terminal does not swallow it). Everything with a menu
  // item keeps its accelerator in the menu.
  const keybindingsRef = useRef(keybindings)
  keybindingsRef.current = keybindings
  const keyTable = useRef<KeyTableState>(initialKeyTable())
  const [prefixOn, setPrefixOn] = useState(false)
  // Prefix mode lapses on its own; the hint goes with it.
  useEffect(() => {
    if (!prefixOn) return
    const t = setTimeout(() => { keyTable.current = initialKeyTable(); setPrefixOn(false) }, PREFIX_TIMEOUT_MS)
    return () => clearTimeout(t)
  }, [prefixOn])
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      // The key-table (tmux's prefix): only while a terminal pane has the keyboard.
      const keys = effectiveKeys(keybindingsRef.current)
      const prefix = keys['prefix'] ?? null
      if (isTerminalFocus(document.activeElement)) {
        if (!e.repeat || keyTable.current.mode === 'prefix') {
          const out = keyTableStep(keyTable.current, {
            key: e.key, code: e.code, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, shift: e.shiftKey, isComposing: e.isComposing,
          }, { prefix, table: buildTable(keybindingsRef.current) }, Date.now())
          keyTable.current = out.state
          setPrefixOn(out.state.mode === 'prefix')
          if (out.action.type !== 'pass') {
            e.preventDefault()
            e.stopPropagation()
            if (out.action.type === 'command') commandRef.current(out.action.id)
            else if (out.action.type === 'literal') {
              const literal = prefixLiteral(prefix)
              if (literal !== null) window.dispatchEvent(new CustomEvent('cockpit:paste', { detail: { text: literal, raw: true, target: document.activeElement } }))
            }
            return
          }
        }
      } else if (keyTable.current.mode === 'prefix') {
        keyTable.current = initialKeyTable()
        setPrefixOn(false)
      }
      if (e.isComposing || e.repeat) return
      const bindings = menuLessBindings(keys)
      if (bindings.length === 0) return
      const hit = bindings.find((b) => keyMatchesAccelerator(e, b.accelerator))
      if (hit === undefined) return
      e.preventDefault()
      e.stopPropagation()
      commandRef.current(hit.id)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  // A shell command (cw pane …) asks a project's window to act; the answer, or the refusal, goes back.
  useEffect(() => cockpitApi.onBridge((payload) => {
    const r = payload as { id?: unknown; kind?: unknown; params?: unknown; projectRoot?: unknown } | null
    if (typeof r?.id !== 'string' || typeof r.kind !== 'string' || typeof r.projectRoot !== 'string') return
    const id = r.id
    const reply = (body: Record<string, unknown>): void => { void cockpitApi.bridgeReply({ id, ...body }).catch(() => undefined) }
    const handle = handles.current.get(r.projectRoot)
    if (handle === undefined) { reply({ ok: false, code: 'PANE_NOT_FOUND', message: 'That project is not open in this window' }); return }
    handle.bridge(r.kind, r.params).then(
      (result) => reply({ ok: true, result }),
      (err: unknown) => {
        const e = err as { code?: unknown; message?: unknown }
        reply({ ok: false, code: typeof e?.code === 'string' ? e.code : 'BRIDGE_HANDLER_FAILED', message: typeof e?.code === 'string' && typeof e.message === 'string' ? e.message : 'The window could not do that' })
      },
    )
  }), [])

  useEffect(() => cockpitApi.onCommand((payload) => {
    const record = payload as { command?: unknown; projectRoot?: unknown; message?: unknown } | null
    // A notice from the main process (e.g. another client holds the command channel).
    if (record?.command === 'notice' && typeof record.message === 'string') { showToast(record.message, 'info'); return }
    // Open Recent and `cw <dir>` from a terminal: main has attached it already.
    if (record?.command === 'show-project' && typeof record.projectRoot === 'string') void activateRef.current(record.projectRoot)
    else if (typeof record?.command === 'string') commandRef.current(record.command)
  }), [])

  const groups = railGroups()
  const projectsForPicker = groups.map((g) => ({ projectRoot: g.projectRoot, name: g.name }))

  function viewHost(root: string): ViewHost {
    return {
      askConfirm,
      // A message from a project off the stage says which project it is about.
      toast: (message, tone) => showToast(root === activeRef.current ? message : `${labelOf(root)}: ${message}`, tone),
      openSettings: (section) => { void handleOpenSettings(section) },
      activate: () => { void activate(root) },
      createElsewhere: (request: NewSessionRequest) => {
        void activate(request.projectRoot, { kind: 'create', name: request.name, options: request.options, launcher: request.launcher })
      },
      defaultsFor,
      projects: projectsForPicker,
      notify,
      sidebarHidden,
      onToggleSidebar: toggleSidebar,
      report: (r, report) => {
        setReports((current) => {
          if (report === null) {
            if (!(r in current)) return current
            const next = { ...current }
            delete next[r]
            return next
          }
          return { ...current, [r]: report }
        })
      },
      register: (r, handle) => {
        if (handle === null) handles.current.delete(r)
        else handles.current.set(r, handle)
      },
      shortcut: (id) => formatAccelerator(effectiveKeys(keybindings)[id] ?? null),
      takePending: (r) => {
        const actions = pending.current.get(r) ?? []
        pending.current.delete(r)
        return actions
      },
    }
  }

  const activeReport = activeRoot === null ? undefined : reports[activeRoot]

  // The window's title names the project and its focused session: several projects each have
  // a "shell-1", and the title is what Mission Control and the app switcher show.
  const activeGroup = activeRoot === null ? undefined : groups.find((g) => g.projectRoot === activeRoot)
  const focusedSessionName = activeGroup?.sessions.find((s) => s.id === activeReport?.focusedId)?.name
  const windowTitle = activeGroup === undefined
    ? 'crossweave Cockpit'
    : `${activeGroup.name}${focusedSessionName === undefined ? '' : ` — ${focusedSessionName}`}`
  useEffect(() => { document.title = windowTitle }, [windowTitle])

  return (
    <div class={`cockpit-shell${sidebarHidden ? ' is-sidebar-hidden' : ''}`}>
      {folderDialog !== null ? (
        <OpenFolderDialog
          path={folderDialog.path}
          info={folderDialog.info}
          onOpen={(root) => activate(root)}
          onInitGit={() => initGitIn(folderDialog.path)}
          {...(folderDialog.info.kind === 'plain' ? { onOpenPlain: () => { void openPlain(folderDialog.path) } } : {})}
          onClose={() => setFolderDialog(null)}
        />
      ) : null}
      {confirmState !== null ? (
        <ConfirmDialog
          {...confirmState}
          onConfirm={() => { confirmState.resolve(true); setConfirmState(null) }}
          onCancel={() => { confirmState.resolve(false); setConfirmState(null) }}
        />
      ) : null}
      {settingsOpen !== null ? (
        <SettingsPage
          initialSection={settingsOpen.section}
          initial={settingsOpen.settings}
          availability={settingsOpen.availability}
          defaults={settingsOpen.defaults}
          importSources={settingsOpen.importSources}
          onImport={(from) => cockpitApi.importTerminal(from)}
          loadFonts={loadFonts}
          seenModels={[...new Set(groups.flatMap((g) => g.sessions.flatMap((s) => Object.keys(s.usage?.byModel ?? {}))))]}
          onPreviewAppearance={(a, colors) => {
            applyAppearance(a)
            applyTheme(resolveTheme(a?.theme, colors ?? terminalLook?.colors, systemDark))
          }}
          hasTerminalColors={terminalLook?.colors !== undefined}
          notify={notify}
          onNotify={(next) => {
            setNotify(next)
            writeString(NOTIFY_SOUND_KEY, next.sound ? '1' : '0')
            writeString(DOCK_BADGE_KEY, next.dockBadge ? '1' : '0')
            writeString(NOTIFY_FINISH_KEY, next.finish ? '1' : '0')
          }}
          onSave={saveSettings}
          onClose={() => {
            // Cancel (or Save, already applied): back to what is saved.
            applyAppearance(savedAppearance.current)
            applyTheme(resolveTheme(savedAppearance.current?.theme, terminalLook?.colors, systemDark))
            setSettingsOpen(null)
          }}
        />
      ) : null}
      {prefixOn ? <KeyTableHint keybindings={keybindings} /> : null}
      {shortcutsOpen ? (
        <ShortcutsDialog keybindings={keybindings} onClose={() => setShortcutsOpen(false)}
          onEdit={() => { setShortcutsOpen(false); void handleOpenSettings('keyboard') }} />
      ) : null}
      {sessionHistoryOpen ? (
        <SessionHistoryDialog load={() => cockpitApi.sessionHistory(500)} onClose={() => setSessionHistoryOpen(false)} />
      ) : null}
      {projectSettings !== null ? (
        <ProjectSettings
          projectRoot={projectSettings.projectRoot}
          folderName={baseName(projectSettings.projectRoot)}
          initial={prefs[projectSettings.projectRoot] ?? {}}
          launchers={projectSettings.launchers}
          branches={projectSettings.branches}
          onSave={(next) => {
            updatePrefs(projectSettings.projectRoot, {
              label: next.label, color: next.color, launcher: next.launcher,
              worktree: next.worktree, base: next.base, hideEnded: next.hideEnded,
            })
            setProjectSettings(null)
          }}
          onClose={() => setProjectSettings(null)}
        />
      ) : null}
      {!sidebarHidden ? (
        <Sidebar
          projects={groups}
          focusedId={activeReport?.focusedId ?? null}
          now={now}
          colorById={activeReport?.colors ?? {}}
          onToggleSidebar={toggleSidebar}
          onNew={(root) => { void activate(root, { kind: 'new' }) }}
          onOpenProject={() => { void openProject() }}
          onOpenRecent={(root) => { void activate(root) }}
          loadRecent={() => cockpitApi.recentProjects()}
          onCommandBar={() => { if (activeRef.current !== null) handles.current.get(activeRef.current)?.command('command-bar') }}
          query={railQuery}
          onQuery={setRailQuery}
          renaming={renaming}
          onRenaming={setRenaming}
          onProjectAction={onProjectAction}
          onProjectColor={(root, color) => updatePrefs(root, { color: color ?? undefined })}
          onRenameProject={(root, label) => updatePrefs(root, { label: label === '' ? undefined : label })}
          onRenameSession={renameSessionIn}
          onSetNote={setNoteIn}
          onReorder={onReorder}
          onFolder={(root, id, how) => { void onFolder(root, id, how) }}
          showUsage={usageSettings?.show ?? true}
          prices={usageSettings?.prices}
          onSettings={() => { void handleOpenSettings() }}
          onSelect={(root, id) => onRailAction(root, id, 'focus')}
          onAction={onRailAction}
          onSetColor={(sessionId, color) => {
            if (activeRef.current !== null) handles.current.get(activeRef.current)?.setColor(sessionId, color)
          }}
        />
      ) : null}
      <TerminalLookContext.Provider value={terminalLook}>
      <PaneThemeContext.Provider value={paneTheme}>
      <div class="cockpit-views">
        {booted && activeRoot === null ? (
          <Welcome
            projects={openRoots.map((root) => ({ root, label: labelOf(root) }))}
            onOpen={() => { void openProject() }}
            onSwitch={(root) => { void activate(root) }}
          />
        ) : null}
        {mounted.map((root) => (
          <ProjectView key={root} projectRoot={root} visible={root === activeRoot} host={viewHost(root)} />
        ))}
      </div>
      </PaneThemeContext.Provider>
      </TerminalLookContext.Provider>
      <UpdateNotice />
      <Toast message={toast?.message ?? null} tone={toast?.tone ?? 'info'} onDone={() => setToast(null)} />
    </div>
  )
}

/**
 * The app opened with no project yet (from the Dock, Spotlight): open one, or go back
 * to one this window had open.
 */
function Welcome({ projects, onOpen, onSwitch }: { projects: Array<{ root: string; label: string }>; onOpen: () => void; onSwitch: (root: string) => void }) {
  return (
    <main class="cockpit-welcome" aria-label="Welcome">
      <div class="cockpit-welcome__drag" />
      <div class="cockpit-welcome__body">
        <h1>crossweave</h1>
        <p class="cockpit-muted">Open a project folder to start sessions in it — a terminal or an agent CLI, in the project folder or in a worktree of its own.</p>
        <button type="button" class="cockpit-btn cockpit-btn--primary cockpit-welcome__open" onClick={onOpen}>Open project…</button>
        {projects.length > 0 ? (
          <ul class="cockpit-welcome__recent">
            {projects.map(({ root, label }) => (
              <li key={root}>
                <button type="button" onClick={() => onSwitch(root)} title={root}>
                  <strong>{label}</strong>
                  <span class="cockpit-muted">{root}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </main>
  )
}

/** A short-lived message where the footer used to be: land results, action errors. */
function Toast({ message, tone, onDone }: { message: string | null; tone: 'info' | 'error'; onDone: () => void }) {
  const doneRef = useRef(onDone)
  doneRef.current = onDone
  useEffect(() => {
    if (message === null) return
    const timer = setTimeout(() => doneRef.current(), tone === 'error' ? 8000 : 5000)
    return () => clearTimeout(timer)
  }, [message, tone])
  if (message === null) return null
  return (
    <div class={`cockpit-toast cockpit-toast--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <span>{message}</span>
      <button type="button" class="cockpit-iconbtn" aria-label="Dismiss" onClick={onDone}>×</button>
    </div>
  )
}
