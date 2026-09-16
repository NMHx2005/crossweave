import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { cockpitApi, type ListedSession } from '../host/cockpit-api'
import {
  blockedSessionFromEvent,
  deriveAttention,
  parseLandabilityByName,
  type AttentionKind,
  type Landability,
} from '../lib/attention'
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
  const cancelledRef = useRef(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      await cockpitApi.ensureWorkspace()
      const listed = await cockpitApi.listSessions()
      const converge = await cockpitApi.convergeStatus().catch(() => undefined)
      if (cancelledRef.current) return
      setSessions(listed)
      setConverge(parseConvergeStatus(converge))
      setLandabilityByName(parseLandabilityByName(converge))
      setFocusedId((current) => {
        if (current && listed.some((session) => session.id === current)) return current
        return listed[0]?.id ?? null
      })
      setStatus(listed.length === 0 ? 'empty' : 'ready')
      setError(null)
    } catch (err) {
      if (cancelledRef.current) return
      setError(err instanceof Error ? err.message : String(err))
      setStatus('error')
    }
  }, [])

  useEffect(() => {
    cancelledRef.current = false
    void load()
    const unsubInvalidate = cockpitApi.onTuiInvalidate(() => {
      void load()
    })
    const unsubEvent = cockpitApi.onTuiEvent((payload) => {
      const name = blockedSessionFromEvent(payload)
      if (name) {
        setBlockedNames((prev) => {
          if (prev.has(name)) return prev
          const next = new Set(prev)
          next.add(name)
          return next
        })
      }
      void load()
    })
    return () => {
      cancelledRef.current = true
      unsubInvalidate()
      unsubEvent()
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
    try {
      await action()
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStatus('error')
    }
  }

  async function handleNew(): Promise<void> {
    const name = window.prompt('New session name')
    if (!name?.trim()) return
    const agent = window.prompt('Agent', 'claude')
    if (!agent?.trim()) return
    await runAction(() => cockpitApi.newSession({ name: name.trim(), agent: agent.trim() }))
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
      land: async (name: string, force?: boolean): Promise<LandResult> =>
        (await cockpitApi.landSession(name, force)) as LandResult,
    }
  }

  async function handleLand(): Promise<void> {
    if (!focused || landBusy || !canLandFocused) return
    setLandBusy(true)
    try {
      const deps = landDeps()
      let result = await landSelected({ ...deps, name: focused.name })
      if (result === 'needs_confirm_unknown') {
        const reason =
          converge.unknown.find((entry) => entry.name === focused.name)?.reason ??
          'incomplete evidence'
        if (!window.confirm(`Land “${focused.name}” with incomplete evidence?\n${reason}`)) {
          return
        }
        result = await landSelected({ ...deps, name: focused.name, forceUnknown: true })
      }
      if (result === 'blocked') {
        setLandMessage(focusedBlockedReason ? `blocked: ${focusedBlockedReason}` : `blocked: ${focused.name}`)
        return
      }
      if (result === 'failed') {
        setLandMessage(`land failed: ${focused.name}`)
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
        onStop={() => {
          void handleStop()
        }}
        onKill={() => {
          void handleKill()
        }}
      />
      <Stage sessions={sessions} focusedId={focusedId} status={status} error={error} />
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
        {landMessage ? <p class="cockpit-muted">{landMessage}</p> : null}
      </footer>
    </div>
  )
}
