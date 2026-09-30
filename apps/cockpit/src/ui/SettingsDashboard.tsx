/** @jsxImportSource preact */
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { cockpitApi, projectApi } from '../host/cockpit-api'
import { plainErrorMessage } from '../lib/cockpit-host'
import { createLoadGate } from '../lib/load-gate'
import {
  diskByProject, formatBytes, lastTouched, parseDashboard, perDaySeries, projectRows, sessionRows, suggestions, summarize,
  type DashboardData, type SessionSort, type SessionRow, type Suggestion,
} from '../lib/dashboard'
import { relativeTime } from '../lib/rail'
import { ConfirmDialog, type ConfirmRequest } from './ConfirmDialog'
import { DayBars, DiskBars } from './DashCharts'
import { Segmented, SettingsGroup } from './SettingsKit'

export const SESSIONS_SHOWN = 12
/** While something is still being measured, ask again this often (and give up after `MAX_POLLS`). */
const POLL_MS = 2000
const MAX_POLLS = 40

export type Notice = { text: string; error: boolean }

const clockTime = (at: number): string => new Date(at).toTimeString().slice(0, 8)
const ageText = (s: SessionRow['session'], now: number): string => {
  const rel = relativeTime(lastTouched(s), now)
  return rel === undefined ? 'no activity recorded' : rel === 'now' ? 'active now' : `${rel} ago`
}
const STATE_WORDS = { running: 'running', stopped: 'stopped', ended: 'ended' } as const
export const stateOf = (status: string): keyof typeof STATE_WORDS => (status === 'running' || status === 'waiting' ? 'running' : status === 'dead' || status === 'landed' ? 'ended' : 'stopped')

const ACTION_WORDS: Record<Suggestion['kind'], string> = { cleanup: 'Clean up…', delete: 'Delete…', unlanded: 'Review & delete…', stop: 'Stop…' }

export type DashboardViewProps = {
  /** null until the first answer arrives. */
  data: DashboardData | null
  loading: boolean
  /** The whole request failed (not one project: that is inside `data`). */
  error: string | null
  notice: Notice | null
  now: number
  sort: SessionSort
  showAll: boolean
  isBusy: (sessionId: string) => boolean
  onRefresh: () => void
  onSort: (next: SessionSort) => void
  onShowAll: (next: boolean) => void
  onSuggestion: (p: Suggestion) => void
  onStop: (root: string, s: SessionRow['session']) => void
  onDelete: (root: string, s: SessionRow['session']) => void
}

/**
 * The page as pure drawing: everything it shows comes in as props, so each state — loading, a failed request, no project, an old
 * daemon, a silent one, still measuring, nothing to suggest — can be tested without a window or a daemon. It uses no hooks (the two
 * charts, which keep their own view toggle, are the only stateful children).
 */
export function DashboardView(p: DashboardViewProps) {
  const { data, now } = p
  const summary = data === null ? null : summarize(data)
  const rows = data === null ? [] : projectRows(data)
  const sessions = data === null ? [] : sessionRows(data, p.sort)
  const proposals = data === null ? [] : suggestions(data, now)
  const bars = data === null ? [] : diskByProject(data)
  const days = data === null ? [] : perDaySeries(data, now)

  return (
    <>
      <div class="cockpit-dash__bar">
        <span class="cockpit-muted" role="status" aria-live="polite">
          {p.loading && data === null ? 'Reading your projects…' : data ? `Updated ${clockTime(data.at || now)}${p.loading ? ' · refreshing…' : ''}` : ''}
        </span>
        <button type="button" class="cockpit-btn cockpit-btn--sm" disabled={p.loading} onClick={p.onRefresh}>Refresh</button>
      </div>

      {p.notice !== null ? <p class={p.notice.error ? 'cockpit-error' : 'cockpit-dash__notice'} role={p.notice.error ? 'alert' : 'status'}>{p.notice.text}</p> : null}
      {p.error !== null ? (
        <SettingsGroup title="Could not read the numbers">
          <div class="cockpit-scard__block">
            <p class="cockpit-error" role="alert">{p.error}</p>
            <div><button type="button" class="cockpit-btn cockpit-btn--sm" onClick={p.onRefresh}>Try again</button></div>
          </div>
        </SettingsGroup>
      ) : null}

      {data !== null && data.projects.length === 0 ? (
        <SettingsGroup>
          <div class="cockpit-scard__block"><p class="cockpit-muted">No project is open in this window. Open one and its sessions, disk and memory show up here.</p></div>
        </SettingsGroup>
      ) : null}

      {summary !== null && data !== null && data.projects.length > 0 ? (
        <>
          {summary.needsRestart > 0 ? (
            <p class="cockpit-dash__notice" role="status">
              {summary.needsRestart === 1 ? '1 project runs' : `${summary.needsRestart} projects run`} a daemon older than this app, so its numbers are missing. Restart it to see them —
              that ends its running sessions, so pick a quiet moment.
            </p>
          ) : null}

          <SettingsGroup title="Overview" dataSetting="dashboard-summary">
            <div class="cockpit-scard__block">
              <div class="cockpit-stats">
                <Stat label="Projects" value={String(summary.projects)} sub={summary.unreachable > 0 ? `${summary.unreachable} not answering` : 'open in this window'} />
                <Stat label="Sessions" value={String(summary.sessions.total)} sub={`${summary.sessions.running} running · ${summary.sessions.stopped} stopped · ${summary.sessions.ended} ended`} />
                <Stat label="Worktree disk" value={`${summary.diskApprox ? '≥ ' : ''}${formatBytes(summary.diskBytes)}`} sub={summary.diskUnmeasured > 0 ? `${summary.diskUnmeasured} still measuring…` : 'measured'} />
                <Stat label="Memory now" value={formatBytes(summary.memoryBytes)} sub={data.app === null ? 'app figures unavailable' : `app ${formatBytes(data.app.memoryBytes)} · ${data.app.processes} processes`} />
              </div>
            </div>
          </SettingsGroup>

          <SettingsGroup title="Suggestions" dataSetting="dashboard-suggestions" note="Only proposals: nothing happens until you confirm, and each dialog says exactly what would be lost. Sessions you are working in are never suggested.">
            {proposals.length === 0 ? (
              <div class="cockpit-scard__block"><p class="cockpit-muted">Nothing to suggest — your sessions look lean.</p></div>
            ) : proposals.map((s) => (
              <div key={s.id} class="cockpit-srow" data-suggestion={s.id}>
                <div class="cockpit-srow__text">
                  <div class="cockpit-srow__label">
                    {s.title}
                    {s.danger === 'unlanded' ? <span class="cockpit-pill is-warn">unlanded work</span> : null}
                  </div>
                  <div class="cockpit-srow__desc">{s.reason}</div>
                  <div class="cockpit-srow__desc">{s.projectName} · {s.sessionNames.slice(0, 3).join(', ')}{s.sessionNames.length > 3 ? ` +${s.sessionNames.length - 3}` : ''}</div>
                </div>
                <div class="cockpit-srow__control">
                  <span class="cockpit-dash__reclaim">{s.reclaimBytes === null ? (s.kind === 'stop' ? 'frees memory' : 'size unknown') : `frees ≈ ${formatBytes(s.reclaimBytes)}`}</span>
                  <button type="button" class={`cockpit-btn cockpit-btn--sm${s.danger === 'unlanded' ? ' cockpit-btn--danger' : ''}`} disabled={s.sessionIds.some(p.isBusy)} onClick={() => p.onSuggestion(s)}>{ACTION_WORDS[s.kind]}</button>
                </div>
              </div>
            ))}
          </SettingsGroup>

          <SettingsGroup title="Charts">
            <div class="cockpit-scard__block"><DiskBars bars={bars} /></div>
            <div class="cockpit-scard__block"><DayBars series={days} /></div>
          </SettingsGroup>

          <SettingsGroup title="Projects" dataSetting="dashboard-projects">
            <div class="cockpit-scard__block cockpit-dtable__wrap">
              <table class="cockpit-dtable">
                <thead><tr><th>Project</th><th>Sessions</th><th class="is-num">Disk</th><th class="is-num">Daemon memory</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.root}>
                      <td title={r.root}>{r.label}</td>
                      {r.state === 'ok' ? (
                        <>
                          <td>{r.sessions.running} running · {r.sessions.stopped} stopped · {r.sessions.ended} ended</td>
                          <td class="is-num">{r.diskApprox ? '≥ ' : ''}{formatBytes(r.diskBytes)}{r.diskMeasuring ? ' …' : ''}</td>
                          <td class="is-num">{formatBytes(r.memoryBytes)}</td>
                        </>
                      ) : (
                        <td colSpan={3} class="cockpit-muted">
                          {r.state === 'needs-restart' ? 'Its daemon is older than this app — restart it to see its numbers.' : r.message}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SettingsGroup>

          <SettingsGroup title="Sessions" dataSetting="dashboard-sessions">
            <div class="cockpit-srow">
              <div class="cockpit-srow__text"><div class="cockpit-srow__label">Every session, across projects</div></div>
              <div class="cockpit-srow__control">
                <Segmented label="Sort sessions" value={p.sort} onChange={p.onSort}
                  options={[{ id: 'disk', label: 'Disk' }, { id: 'activity', label: 'Recent' }, { id: 'name', label: 'Name' }]} />
              </div>
            </div>
            {sessions.length === 0 ? (
              <div class="cockpit-scard__block"><p class="cockpit-muted">No sessions yet.</p></div>
            ) : (p.showAll ? sessions : sessions.slice(0, SESSIONS_SHOWN)).map((r) => {
              const s = r.session
              const state = stateOf(s.status)
              return (
                <div key={`${r.projectRoot}:${s.id}`} class="cockpit-srow" data-session={s.id}>
                  <div class="cockpit-srow__text">
                    <div class="cockpit-srow__label">
                      <span class="cockpit-dash__name" title={s.name}>{s.name}</span>
                      <span class={`cockpit-pill is-${state}`}>{STATE_WORDS[state]}</span>
                      {(s.ahead ?? 0) > 0 ? <span class="cockpit-pill is-warn" title="Commits not landed yet">↑{s.ahead}</span> : null}
                      {(s.changed ?? 0) > 0 ? <span class="cockpit-pill is-warn" title="Uncommitted files">✎{s.changed}</span> : null}
                    </div>
                    <div class="cockpit-srow__desc">{r.projectLabel} · {ageText(s, now)}{s.shared ? ' · works in the project folder' : ''}</div>
                  </div>
                  <div class="cockpit-srow__control">
                    <span class="cockpit-dash__size">{s.shared ? '—' : s.diskBytes === null ? 'measuring…' : `${s.diskApprox ? '≥ ' : ''}${formatBytes(s.diskBytes)}`}</span>
                    {state === 'running' ? <button type="button" class="cockpit-btn cockpit-btn--sm" disabled={p.isBusy(s.id)} onClick={() => p.onStop(r.projectRoot, s)}>Stop…</button> : null}
                    <button type="button" class="cockpit-btn cockpit-btn--sm" disabled={p.isBusy(s.id)} onClick={() => p.onDelete(r.projectRoot, s)}>Delete…</button>
                  </div>
                </div>
              )
            })}
            {sessions.length > SESSIONS_SHOWN ? (
              <div class="cockpit-scard__block">
                <button type="button" class="cockpit-btn cockpit-btn--sm" onClick={() => p.onShowAll(!p.showAll)}>{p.showAll ? 'Show fewer' : `Show all ${sessions.length}`}</button>
              </div>
            ) : null}
          </SettingsGroup>
        </>
      ) : null}
    </>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div class="cockpit-stat">
      <div class="cockpit-stat__label">{label}</div>
      <div class="cockpit-stat__value">{value}</div>
      <div class="cockpit-stat__sub">{sub}</div>
    </div>
  )
}

type Pending = ConfirmRequest & { ids: string[]; run: () => Promise<string> }

/**
 * What the open projects and their sessions cost, and what could be stopped or deleted to lighten the machine. It only ever
 * *proposes*: every action asks first, in a dialog that says exactly what will be lost, and a session that vanished meanwhile is
 * reported as "already gone", not as a failure. Numbers come from the main process (`dashboard.get`); an old daemon, a silent one
 * or an unreadable answer degrades one project's row, never the page.
 */
export function SettingsDashboard() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [sort, setSort] = useState<SessionSort>('disk')
  const [showAll, setShowAll] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const gate = useRef(createLoadGate()).current
  const alive = useRef(true)
  const polls = useRef(0)

  const refresh = useCallback(async (): Promise<void> => {
    const seq = gate.start()
    setLoading(true)
    try {
      const raw = await cockpitApi.dashboardGet()
      // A later refresh has been shown already, or the page was left: this answer is not wanted.
      if (!alive.current || !gate.accept(seq)) return
      setData(parseDashboard(raw))
      setNow(Date.now())
      setError(null)
    } catch (err) {
      if (!alive.current || !gate.accept(seq)) return
      setError(plainErrorMessage(err))
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [gate])

  useEffect(() => {
    alive.current = true
    void refresh()
    return () => { alive.current = false }
  }, [refresh])

  const unmeasured = useMemo(() => (data ? summarize(data).diskUnmeasured : 0), [data])
  // Disk is measured in the background: until every figure is in, look again shortly (a bounded number of times).
  useEffect(() => {
    if (unmeasured === 0 || polls.current >= MAX_POLLS) return
    const t = setTimeout(() => { polls.current += 1; void refresh() }, POLL_MS)
    return () => clearTimeout(t)
  }, [data, unmeasured, refresh])

  const withBusy = async (ids: readonly string[], run: () => Promise<string>): Promise<void> => {
    setBusy((cur) => new Set([...cur, ...ids]))
    try {
      setNotice({ text: await run(), error: false })
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code
      // Gone between the listing and the click (another window, the CLI): nothing to undo, only to refresh.
      setNotice(code === 'SESSION_NOT_FOUND' || code === 'NOT_FOUND'
        ? { text: 'That session is already gone.', error: false }
        : { text: plainErrorMessage(err), error: true })
    } finally {
      setBusy((cur) => { const next = new Set(cur); for (const id of ids) next.delete(id); return next })
      polls.current = 0
      await refresh()
    }
  }

  const askStop = (root: string, s: SessionRow['session']): void => {
    setPending({
      title: `Stop ${s.name}'s shell?`,
      body: 'Its shell (and whatever runs in it) ends. Its worktree and branch stay, and you can start it again.',
      confirmLabel: 'Stop',
      ids: [s.id],
      run: async () => { await projectApi(root).stopSession(s.id); return `Stopped ${s.name}.` },
    })
  }

  const askDelete = (root: string, s: SessionRow['session'], consequences?: { ahead: number; changed: number }): void => {
    const lost = consequences ?? { ahead: s.ahead ?? 0, changed: s.changed ?? 0 }
    const unlanded = lost.ahead > 0 || lost.changed > 0
    setPending({
      title: `Delete ${s.name}?`,
      body: s.shared
        ? 'Its shell (and whatever runs in it) ends and the session leaves the rail. It works in the project folder, which stays exactly as it is.'
        : `Its shell (and whatever runs in it) ends, and its worktree${s.diskBytes === null ? '' : ` (${formatBytes(s.diskBytes)})`} and branch are deleted.${unlanded ? ` Work that was not landed is lost: ${lost.ahead} commit${lost.ahead === 1 ? '' : 's'} and ${lost.changed} uncommitted file${lost.changed === 1 ? '' : 's'}.` : ''}`,
      confirmLabel: unlanded ? 'Delete and lose the work' : 'Delete',
      ids: [s.id],
      danger: true,
      run: async () => {
        const api = projectApi(root)
        if (stateOf(s.status) !== 'ended') await api.killSession(s.id, false)
        await api.removeSession(s.id)
        return `Deleted ${s.name}${!s.shared && s.diskBytes !== null ? ` — about ${formatBytes(s.diskBytes)} freed` : ''}.`
      },
    })
  }

  const onSuggestion = (p: Suggestion): void => {
    const root = p.projectRoot
    if (p.kind === 'cleanup') {
      setPending({
        title: `Clean up ${p.sessionIds.length} ended session${p.sessionIds.length === 1 ? '' : 's'} in ${p.projectName}?`,
        body: `Their worktrees and branches are deleted${p.reclaimBytes === null ? '' : ` (about ${formatBytes(p.reclaimBytes)})`}. Sessions that still hold unlanded work are kept.`,
        confirmLabel: 'Clean up',
        ids: [...p.sessionIds],
        danger: true,
        run: async () => {
          const result = await cockpitApi.collectGarbage(false, root)
          const n = result.removed?.length ?? 0
          return `Cleaned up ${n} session${n === 1 ? '' : 's'}${(result.kept?.length ?? 0) > 0 ? `; kept ${result.kept?.length} with unlanded work` : ''}.`
        },
      })
      return
    }
    const target = data?.projects.flatMap((e) => (e.state === 'ok' && e.root === root ? e.overview.sessions : [])).find((s) => s.id === p.sessionIds[0])
    if (target === undefined) { setNotice({ text: 'That session is already gone.', error: false }); void refresh(); return }
    if (p.kind === 'stop') askStop(root, target)
    else askDelete(root, target, p.consequences)
  }

  const confirmPending = async (): Promise<void> => {
    const action = pending
    setPending(null)
    if (action !== null) await withBusy(action.ids, action.run)
  }

  return (
    <>
      <DashboardView
        data={data} loading={loading} error={error} notice={notice} now={now} sort={sort} showAll={showAll}
        isBusy={(id) => busy.has(id)}
        onRefresh={() => { polls.current = 0; void refresh() }}
        onSort={(next) => { setSort(next); setShowAll(false) }}
        onShowAll={setShowAll}
        onSuggestion={onSuggestion}
        onStop={askStop}
        onDelete={(root, s) => askDelete(root, s)}
      />
      {pending !== null ? (
        // Escape closes this dialog only: it must not bubble up and close the whole Settings page behind it.
        <div onKeyDown={(e) => { if (e.key === 'Escape') e.stopPropagation() }}>
          <ConfirmDialog title={pending.title} body={pending.body} confirmLabel={pending.confirmLabel} danger={pending.danger === true}
            onConfirm={() => { void confirmPending() }} onCancel={() => setPending(null)} />
        </div>
      ) : null}
    </>
  )
}
