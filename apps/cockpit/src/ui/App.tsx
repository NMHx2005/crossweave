import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { ActivityFeed, activityFromEvent, type ActivityItem } from '../../../../src/domain/activity.js'
import { cockpitApi, type AgentOption, type ListedSession, type TerminalInfo } from '../host/cockpit-api'
import { nextAttentionSession } from '../lib/attention-jump'
import { QuickPicker, type NewSessionOptions } from './QuickPicker'
import { QuickOpen } from './QuickOpen'
import { FilePane } from './FilePane'
import { BrowserPane } from './BrowserPane'
import { SettingsPanel, type UserSettings } from './SettingsPanel'
import { readColors, writeColors, type SessionColor } from '../lib/colors'
import {
  blockedSessionFromEvent,
  deriveAttention,
  nextBlockedNames,
  parseLandabilityByName,
  type AttentionKind,
  type Landability,
} from '../lib/attention'
import {
  createAndStartSession,
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
  parseConvergeStatus,
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
import { AgentRail } from './AgentRail'
import { Stage, type StageStatus } from './Stage'
import { sessionsThatStartedRunning } from '../lib/sessions'

const EMPTY_CONVERGE: ConvergeStatus = { ready: [], unknown: [], blocked: [] }

/** Where this window keeps its tabs: per workspace, in this browser profile only. */
const stageKey = (projectRoot: string): string => `cw.stage.v1:${projectRoot}`

function readStoredStage(projectRoot: string): StageState | null {
  try {
    const text = window.localStorage.getItem(stageKey(projectRoot))
    return text === null ? null : parseStoredStage(text)
  } catch {
    return null
  }
}

export function App() {
  const [sessions, setSessions] = useState<ListedSession[]>([])
  const [stage, setStage] = useState<StageState>(emptyStage)
  const [status, setStatus] = useState<StageStatus>('loading')
  const [error, setError] = useState<string | null>(null)
  const [landabilityByName, setLandabilityByName] = useState<Map<string, Landability>>(
    () => new Map(),
  )
  const [converge, setConverge] = useState<ConvergeStatus>(EMPTY_CONVERGE)
  const [blockedNames, setBlockedNames] = useState<ReadonlySet<string>>(() => new Set())
  const [landBusy, setLandBusy] = useState(false)
  const [landMessage, setLandMessage] = useState<string | null>(null)
  /** Non-null while the ⌘T picker is open. */
  const [pickerAgents, setPickerAgents] = useState<AgentOption[] | null>(null)
  const [layouts, setLayouts] = useState<Record<string, SavedLayout>>({})
  const [branches, setBranches] = useState<string[]>([])
  /** Non-null while ⌘P is open: the session whose worktree it searches. */
  const [quickOpen, setQuickOpen] = useState<{ sessionId: string; name: string; files: string[] } | null>(null)
  const [colors, setColors] = useState<Record<string, SessionColor>>({})
  /** Non-null while Settings is open. */
  const [settingsOpen, setSettingsOpen] = useState<{ settings: UserSettings; agents: AgentOption[] } | null>(null)
  const [usageRows, setUsageRows] = useState<{ date: string; agentKind: string; sessions: number; tokens: number; costUsd: number }[] | null>(null)
  const [paneAttachEpoch, setPaneAttachEpoch] = useState(0)
  const [paneAttachBumps, setPaneAttachBumps] = useState<Record<string, number>>({})
  const lastJournalRef = useRef('')
  /**
   * Recent activity lives in a ref and is mirrored into state: the feed is a mutable
   * unread/ack store (see src/domain/activity.ts), and re-rendering needs a new array
   * reference, not a mutated one. Unread is per-window state, so a reload starting empty
   * is correct rather than a gap.
   */
  const feedRef = useRef(new ActivityFeed())
  const [activity, setActivity] = useState<ActivityItem[]>([])
  const cancelledRef = useRef(false)
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  /** What the previous load saw; null until the first load (see syncStage). */
  const knownRef = useRef<{ sessionIds: Set<string>; terminalIds: Set<string> } | null>(null)
  const projectRootRef = useRef('')

  const load = useCallback(async (opts?: { keepBlocked?: boolean; bumpAttach?: boolean }): Promise<void> => {
    try {
      const loaded = await loadWorkspace(cockpitApi)
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
      const openTerminals = await cockpitApi.listTerminals().catch(() => [] as TerminalInfo[])
      if (cancelledRef.current) return
      setSessions(loaded.sessions)
      const firstLoad = knownRef.current === null
      const known = knownRef.current
      projectRootRef.current = loaded.projectRoot
      if (firstLoad) {
        setColors(readColors(loaded.projectRoot))
        // After ensure, never alongside it: a settings.get racing the first attach
        // failed "Workspace is not attached" and the saved layouts silently vanished.
        void cockpitApi.getSettings().then((s) => {
          const saved = (s as { layouts?: unknown } | null)?.layouts
          if (saved && typeof saved === 'object') setLayouts(saved as Record<string, SavedLayout>)
        }).catch(() => undefined)
      }
      setStage((prev) => {
        // The first load restores this workspace's tabs from the last window, if any.
        const base = firstLoad ? (readStoredStage(loaded.projectRoot) ?? prev) : prev
        return syncStage(base, { sessions: loaded.sessions, terminals: openTerminals }, known)
      })
      knownRef.current = {
        sessionIds: new Set(loaded.sessions.map((s) => s.id)),
        terminalIds: new Set(openTerminals.map((t) => t.terminalId)),
      }
      setConverge(loaded.converge)
      setLandabilityByName(parseLandabilityByName(loaded.converge))
      setStatus(stageStatusAfterLoad(loaded.sessions.length))
      setError(null)
      try {
        const u = (await cockpitApi.usageSummary({ groupBy: 'day+agent' })) as { summaries: { date: string; agentKind: string; sessions: number; tokens: number; costUsd: number }[] } | null
        if (u && Array.isArray((u as { summaries: unknown[] }).summaries)) setUsageRows((u as { summaries: { date: string; agentKind: string; sessions: number; tokens: number; costUsd: number }[] }).summaries)
        else setUsageRows([])
      } catch { setUsageRows([]) }
      if (opts?.bumpAttach) {
        // daemon.gone: every pane's socket is dead, so every pane re-attaches.
        setPaneAttachEpoch((current) => current + 1)
      }
      if (!opts?.keepBlocked) {
        setBlockedNames((prev) => nextBlockedNames(prev, { type: 'clear' }))
      }
    } catch (err) {
      if (cancelledRef.current) return
      setError(plainErrorMessage(err))
      setStatus(stageStatusAfterFailure(sessionsRef.current.length))
    }
  }, [])

  useEffect(() => {
    cancelledRef.current = false
    void load()
    const unsub = subscribeCockpitHost(cockpitApi, {
      refresh: (source) => {
        void load({
          keepBlocked: source === 'event',
          bumpAttach: shouldBumpPaneAttach(source),
        })
      },
      onEvent: (payload) => {
        const item = activityFromEvent(payload)
        if (item) {
          feedRef.current.push(item.kind, item.session)
          setActivity(feedRef.current.all())
        }
        const name = blockedSessionFromEvent(payload)
        if (!name) return
        setBlockedNames((prev) => nextBlockedNames(prev, { type: 'blocked', name }))
      },
    })
    return () => {
      cancelledRef.current = true
      unsub()
    }
  }, [load])

  // Keep this workspace's tabs for the next window. Best effort: storage can be full
  // or disabled, and losing the layout is not worth an error.
  useEffect(() => {
    if (projectRootRef.current === '') return
    try {
      window.localStorage.setItem(stageKey(projectRootRef.current), JSON.stringify(stage))
    } catch {
      // ignore
    }
  }, [stage])

  // Menu accelerators (⌘T, ⌘⇧A, ⌘⇧T) arrive as commands from the main process. The ref
  // keeps the listener registered once while always calling the current handlers.
  const commandRef = useRef<(command: string) => void>(() => undefined)
  commandRef.current = (command: string) => {
    if (command === 'new-agent') void handleNew()
    else if (command === 'jump-attention') jumpToAttention()
    else if (command === 'open-terminal') void handleTerminal()
    else if (command === 'open-file') void handleOpenFile()
    else if (command === 'open-browser') handleOpenBrowser()
    else if (command === 'open-settings') void handleOpenSettings()
  }
  useEffect(() => cockpitApi.onCommand((payload) => {
    const command = (payload as { command?: unknown } | null)?.command
    if (typeof command === 'string') commandRef.current(command)
  }), [])

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
    void cockpitApi.journalSet(ids).catch(() => undefined)
  }, [stage])

  const attentionById = useMemo(() => {
    const out: Record<string, AttentionKind> = {}
    for (const session of sessions) {
      out[session.id] = deriveAttention({
        status: session.status ?? '',
        landability: landabilityByName.get(session.name),
        recentBlocked: blockedNames.has(session.name),
      })
    }
    return out
  }, [sessions, landabilityByName, blockedNames])

  const focused = sessions.find((session) => session.id === focusedId) ?? null
  const focusedLandability = focused ? landabilityByName.get(focused.name) : undefined
  const focusedBlockedReason = focused
    ? converge.blocked.find((entry) => entry.name === focused.name)?.reason
    : undefined
  const canLandFocused = focusedLandability === 'ready' || focusedLandability === 'unknown'

  /**
   * Show a session: its existing pane if a tab has one, else a new tab. Looking at a
   * session is also what clears its activity — the rail shows what you have not seen.
   */
  function focusSession(sessionId: string): void {
    setStage((s) => {
      const at = locatePane(s, `session:${sessionId}`)
      if (at) return focusPane(s, at.tabId, at.paneId)
      const name = sessionsRef.current.find((x) => x.id === sessionId)?.name ?? sessionId
      return openInNewTab(s, { kind: 'session', sessionId }, name)
    })
    const session = sessions.find((s) => s.id === sessionId)
    if (!session) return
    feedRef.current.ack(session.name)
    setActivity(feedRef.current.all())
  }

  function selectActivity(sessionName: string): void {
    feedRef.current.ack(sessionName)
    setActivity(feedRef.current.all())
    const session = sessions.find((s) => s.name === sessionName)
    // A session that has since been removed still gets its item acknowledged — an
    // unactionable row that can never be cleared is worse than one that disappears.
    if (session) focusSession(session.id)
  }

  async function runAction(action: () => Promise<unknown>): Promise<void> {
    const actionError = await runCockpitAction(action, (partialFailure) =>
      load({ keepBlocked: partialFailure }),
    )
    if (actionError) {
      setError(actionError)
      setStatus(stageStatusAfterFailure(sessionsRef.current.length))
    }
  }

  async function handleNew(): Promise<void> {
    // Fetched on open, not cached: an agent installed or enabled a minute ago should
    // show up without a reload.
    const [agents, branchList] = await Promise.all([
      cockpitApi.listAgents().catch(() => [] as AgentOption[]),
      cockpitApi.listBranches().catch(() => [] as string[]),
    ])
    setBranches(branchList)
    setPickerAgents(agents)
  }

  async function handlePickerCreate(agentId: string, name: string, options: NewSessionOptions): Promise<void> {
    setPickerAgents(null)
    await runAction(async () => {
      const created = await createAndStartSession(cockpitApi, { name, agent: agentId, ...options }) as { id?: string }
      if (typeof created?.id === 'string') focusSession(created.id)
    })
  }

  function jumpToAttention(): void {
    const target = nextAttentionSession(sessions, attentionById, focusedId)
    if (target !== null) focusSession(target)
  }

  async function handleStart(): Promise<void> {
    if (!focused) return
    const target = focused.id
    // The pane re-attaches from load(): the session's move to `running` is detected
    // there, the same way as when the CLI or another window starts it.
    await runAction(() => cockpitApi.resumeSession(target))
  }

  /** A shell for `sessionId`, split beside `at` (or in a tab of its own). */
  async function openShell(sessionId: string, at?: { tabId: string; paneId: string; dir: SplitDir }): Promise<void> {
    await runAction(async () => {
      const opened = await cockpitApi.openTerminal(sessionId)
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

  async function handleOpenFile(): Promise<void> {
    if (!focused) return
    const target = focused
    await runAction(async () => {
      const files = await cockpitApi.listFiles(target.id)
      setQuickOpen({ sessionId: target.id, name: target.name, files })
    })
  }

  function handleOpenBrowser(): void {
    // A running session's leased port is where its dev server listens by convention.
    const port = focused?.portBase
    openSurface({ kind: 'browser', url: port === undefined ? '' : `http://localhost:${port}/` }, 'browser')
  }

  async function handleOpenSettings(): Promise<void> {
    await runAction(async () => {
      const [settings, agents] = await Promise.all([cockpitApi.getSettings(), cockpitApi.listAgents()])
      setSettingsOpen({ settings: settings as UserSettings, agents })
    })
  }

  /** Save through the daemon, which validates; its refusal is shown in the form. */
  async function saveSettings(next: UserSettings): Promise<string | null> {
    try {
      const saved = await cockpitApi.setSettings(next) as UserSettings
      setLayouts((saved.layouts ?? {}) as Record<string, SavedLayout>)
      return null
    } catch (err) {
      // Only the daemon's sentence: not the IPC wrapper or the error class in front of it.
      return plainErrorMessage(err)
    }
  }

  async function handleTerminal(): Promise<void> {
    if (!focused) return
    await openShell(focused.id)
  }

  function handleClosePane(tabId: string, paneId: string, pane: PaneRef): void {
    // Closing a shell's pane ends the shell; closing an agent's pane only hides it.
    if (pane.kind === 'terminal') void cockpitApi.closeTerminal(pane.terminalId).catch(() => undefined)
    setStage((s) => closePane(s, tabId, paneId))
  }

  async function saveLayouts(next: Record<string, SavedLayout>): Promise<void> {
    setLayouts(next)
    try {
      const current = await cockpitApi.getSettings() as Record<string, unknown>
      await cockpitApi.setSettings({ ...current, layouts: next })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleStop(): Promise<void> {
    if (!focused) return
    await runAction(() => cockpitApi.stopSession(focused.id))
  }

  async function handleKill(): Promise<void> {
    if (!focused) return
    if (!window.confirm(`Kill session “${focused.name}”? This cannot be undone.`)) return
    await runAction(() => cockpitApi.killSession(focused.id))
  }

  function landDeps() {
    return {
      getStatus: async () => parseConvergeStatus(await cockpitApi.convergeStatus()),
      land: async (name: string): Promise<LandResult> =>
        (await cockpitApi.landSession(name)) as LandResult,
    }
  }

  async function handleLand(): Promise<void> {
    if (!focused || landBusy || !canLandFocused) return
    setLandBusy(true)
    try {
      const deps = landDeps()
      let result = await landSelected({ ...deps, name: focused.name })
      if (result.status === 'needs_confirm_unknown') {
        const reason =
          converge.unknown.find((entry) => entry.name === focused.name)?.reason ??
          'incomplete evidence'
        if (!window.confirm(`Land “${focused.name}” with incomplete evidence?\n${reason}`)) {
          return
        }
        result = await landSelected({ ...deps, name: focused.name, forceUnknown: true })
      }
      if (result.status === 'blocked') {
        setLandMessage(focusedBlockedReason ? `blocked: ${focusedBlockedReason}` : `blocked: ${focused.name}`)
        return
      }
      if (result.status === 'failed') {
        setLandMessage(result.error)
        return
      }
      setLandMessage(`landed ${focused.name}`)
      await load()
    } catch (err) {
      setLandMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setLandBusy(false)
    }
  }

  async function handleLandAll(): Promise<void> {
    if (landBusy) return
    setLandBusy(true)
    setLandMessage('landing ready sessions…')
    try {
      const landedSoFar: string[] = []
      const result = await landAllReady({
        getStatus: async () => parseConvergeStatus(await cockpitApi.convergeStatus()),
        land: async (name) => (await cockpitApi.landSession(name)) as LandResult,
        onProgress: (name) => {
          landedSoFar.push(name)
          setLandMessage(`landed ${landedSoFar.join(', ')}`)
        },
      })
      if (result.failedAt) {
        setLandMessage(
          `landed ${result.landed.join(', ') || '(none)'}; stopped at ${result.failedAt}: ${result.error ?? 'failed'}`,
        )
      } else if (result.landed.length === 0) {
        const unknown = converge.unknown[0]
        setLandMessage(unknown ? `nothing to land: ${unknown.reason}` : 'nothing to land')
      } else {
        setLandMessage(`landed ${result.landed.join(', ')}`)
      }
      await load()
    } catch (err) {
      setLandMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setLandBusy(false)
    }
  }

  return (
    <div class="cockpit-shell">
      {pickerAgents !== null ? (
        <QuickPicker
          agents={pickerAgents}
          takenNames={sessions.map((s) => s.name)}
          branches={branches}
          onCreate={(agentId, name, options) => {
            void handlePickerCreate(agentId, name, options)
          }}
          onCancel={() => setPickerAgents(null)}
        />
      ) : null}
      {settingsOpen !== null ? (
        <SettingsPanel
          initial={settingsOpen.settings}
          agents={settingsOpen.agents}
          onSave={saveSettings}
          onClose={() => setSettingsOpen(null)}
        />
      ) : null}
      {quickOpen !== null ? (
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
      <AgentRail
        sessions={sessions}
        focusedId={focusedId}
        attentionById={attentionById}
        activity={activity}
        onFocus={focusSession}
        onSelectActivity={selectActivity}
        onNew={() => {
          void handleNew()
        }}
        onStart={() => {
          void handleStart()
        }}
        onStop={() => {
          void handleStop()
        }}
        onKill={() => {
          void handleKill()
        }}
        onTerminal={() => {
          void handleTerminal()
        }}
        colorById={colors}
        onSetColor={(sessionId, color) => {
          const next = { ...colors }
          if (color === null) delete next[sessionId]
          else next[sessionId] = color
          setColors(next)
          writeColors(projectRootRef.current, next)
        }}
      />
      <Stage
        stage={stage}
        sessions={sessions}
        status={status}
        error={error}
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
      />
      {usageRows !== null && usageRows.length > 0 ? (
        <section class="cockpit-usage" aria-label="Usage summary">
          <h3 class="cockpit-usage__title">Usage — estimate, not billing</h3>
          <table class="cockpit-usage__table">
            <thead>
              <tr><th>date</th><th>agent</th><th>sessions</th><th>tokens</th><th>cost</th></tr>
            </thead>
            <tbody>
              {usageRows.map((r) => (
                <tr key={`${r.date}-${r.agentKind}`}>
                  <td>{r.date}</td><td>{r.agentKind}</td><td>{r.sessions}</td><td>{r.tokens}</td><td>${r.costUsd.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
      <footer class="cockpit-footer">
        <div class="cockpit-footer__actions">
          <button
            type="button"
            onClick={() => {
              void handleLand()
            }}
            disabled={!canLandFocused || landBusy}
            title={focusedBlockedReason}
          >
            Land
          </button>
          <button
            type="button"
            onClick={() => {
              void handleLandAll()
            }}
            disabled={converge.ready.length === 0 || landBusy}
          >
            Land all
          </button>
        </div>
        {error ? (
          <p class="cockpit-error" role="alert">
            {error}
          </p>
        ) : landMessage ? (
          <p class="cockpit-muted">{landMessage}</p>
        ) : null}
      </footer>
    </div>
  )
}
