import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { cockpitApi, type ListedSession } from '../host/cockpit-api'
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
import { AgentRail } from './AgentRail'
import { Stage, type StageStatus } from './Stage'

const EMPTY_CONVERGE: ConvergeStatus = { ready: [], unknown: [], blocked: [] }

export function App() {
  const [sessions, setSessions] = useState<ListedSession[]>([])
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [status, setStatus] = useState<StageStatus>('loading')
  const [error, setError] = useState<string | null>(null)
  const [landabilityByName, setLandabilityByName] = useState<Map<string, Landability>>(
    () => new Map(),
  )
  const [converge, setConverge] = useState<ConvergeStatus>(EMPTY_CONVERGE)
  const [blockedNames, setBlockedNames] = useState<ReadonlySet<string>>(() => new Set())
  const [landBusy, setLandBusy] = useState(false)
  const [landMessage, setLandMessage] = useState<string | null>(null)
  const [paneAttachEpoch, setPaneAttachEpoch] = useState(0)
  const [paneAttachBumps, setPaneAttachBumps] = useState<Record<string, number>>({})
  const cancelledRef = useRef(false)
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions

  const load = useCallback(async (opts?: { keepBlocked?: boolean; bumpAttach?: boolean }): Promise<void> => {
    try {
      const loaded = await loadWorkspace(cockpitApi)
      if (cancelledRef.current) return
      setSessions(loaded.sessions)
      setConverge(loaded.converge)
      setLandabilityByName(parseLandabilityByName(loaded.converge))
      setFocusedId((current) => {
        if (current && loaded.sessions.some((session) => session.id === current)) return current
        return loaded.sessions[0]?.id ?? null
      })
      setStatus(stageStatusAfterLoad(loaded.sessions.length))
      setError(null)
      if (opts?.bumpAttach) {
        // daemon.gone: every pane's socket is dead, so every pane re-attaches.
        setPaneAttachEpoch((current) => current + 1)
      }
      if (!opts?.keepBlocked) {
        setBlockedNames((prev) => nextBlockedNames(prev, { type: 'clear' }))
      }
    } catch (err) {
      if (cancelledRef.current) return
      setError(err instanceof Error ? err.message : String(err))
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
    const name = window.prompt('New session name')
    if (!name?.trim()) return
    const agent = window.prompt('Agent', 'claude')
    if (!agent?.trim()) return
    await runAction(() => createAndStartSession(cockpitApi, { name: name.trim(), agent: agent.trim() }))
  }

  async function handleStart(): Promise<void> {
    if (!focused) return
    const target = focused.id
    await runAction(() => cockpitApi.resumeSession(target))
    // The pane attached to a session that had no agent, so it is showing the reason
    // instead of a terminal. Re-key THAT pane only: a global bump remounted every
    // other pane too, which flickered four live agent terminals to fix one (measured:
    // a MutationObserver on the grid saw 4 panes removed by a single Start click).
    setPaneAttachBumps((bumps) => ({ ...bumps, [target]: (bumps[target] ?? 0) + 1 }))
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
      <AgentRail
        sessions={sessions}
        focusedId={focusedId}
        attentionById={attentionById}
        onFocus={setFocusedId}
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
      />
      <Stage
        sessions={sessions}
        focusedId={focusedId}
        status={status}
        error={error}
        paneAttachEpoch={paneAttachEpoch}
        paneAttachBumps={paneAttachBumps}
        onFocus={setFocusedId}
      />
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
