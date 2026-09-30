import { describe, expect, test } from 'bun:test'
import {
  IDLE_SHELL_HOURS, MIN_DELETE_BYTES, STALE_EMPTY_DAYS, STALE_UNLANDED_DAYS,
  diskByProject, formatBytes, parseDashboard, perDaySeries, projectRows, sessionRows, suggestions, summarize,
  type DashboardData, type ProjectEntry, type ProjectOverview, type SessionStat,
} from '../src/lib/dashboard'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 8, 30, 12, 0, 0)
const ago = (ms: number): string => new Date(NOW - ms).toISOString()

const session = (over: Partial<SessionStat> & { id: string }): SessionStat => ({
  name: over.id, status: 'idle', branch: `cw/${over.id}`, worktreePath: `/wt/${over.id}`, shared: false, agent: null, activity: 'idle',
  createdAt: ago(30 * DAY), lastActiveAt: ago(30 * DAY), lastActivityAt: null, diskBytes: 100 * 1024 * 1024, diskApprox: false, diskMeasuring: false,
  ahead: 0, changed: 0, tokens: null, costUsd: 0, ...over,
})

const overview = (sessions: SessionStat[], over: Partial<ProjectOverview> = {}): ProjectOverview => ({
  workspaceId: 'ws_1', root: '/p', measuredAt: NOW, process: { pid: 1, uptimeMs: 1000, rssBytes: 80 * 1024 * 1024, heapUsedBytes: 1 },
  running: 0, terminals: 0, limits: { perSessionBytes: 1e10, perWorkspaceBytes: 1e11 }, sessions, startedPerDay: {}, landedPerDay: {}, ...over,
})

const project = (root: string, sessions: SessionStat[], over: Partial<ProjectOverview> = {}): ProjectEntry => ({ root, name: root.split('/').pop() as string, state: 'ok', overview: overview(sessions, { root, ...over }) })
const data = (projects: ProjectEntry[], app: DashboardData['app'] = null): DashboardData => ({ projects, app, at: NOW })

describe('formatBytes', () => {
  test('binary units, one decimal from KB up, clamped at TB', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB')
    expect(formatBytes(1.5 * 1024 ** 4)).toBe('1.5 TB')
    expect(formatBytes(5000 * 1024 ** 4)).toBe('5000.0 TB')
  })

  test('nothing measured is a dash, and a nonsense number is never shown as a number', () => {
    for (const v of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) expect(formatBytes(v)).toBe('—')
    expect(formatBytes(-5)).toBe('0 B')
  })
})

describe('parseDashboard', () => {
  test('anything that is not the expected shape is an empty dashboard, never a throw', () => {
    for (const bad of [null, undefined, 5, 'x', [], {}, { projects: 'no' }]) {
      const d = parseDashboard(bad)
      expect(d.projects).toEqual([])
      expect(d.app).toBeNull()
    }
  })

  test('keeps a good project, marks an old daemon and an unreachable one, drops entries with no root', () => {
    const good = project('/p', [session({ id: 'a' })])
    const parsed = parseDashboard({
      at: NOW,
      app: { memoryBytes: 500, cpuPercent: 3.5, processes: 4 },
      projects: [
        { root: '/p', name: 'p', state: 'ok', overview: good.state === 'ok' ? good.overview : null },
        { root: '/old', name: 'old', state: 'needs-restart' },
        { root: '/down', name: 'down', state: 'unreachable', message: 'nope' },
        { name: 'no root', state: 'ok' },
        { root: '/weird', name: 'weird', state: 'sparkly' },
      ],
    })
    expect(parsed.projects.map((p) => [p.root, p.state])).toEqual([['/p', 'ok'], ['/old', 'needs-restart'], ['/down', 'unreachable'], ['/weird', 'unreachable']])
    expect(parsed.app).toEqual({ memoryBytes: 500, cpuPercent: 3.5, processes: 4 })
  })

  test('sessions with no id or name are dropped and bad numbers become null, not NaN', () => {
    const parsed = parseDashboard({
      projects: [{ root: '/p', name: 'p', state: 'ok', overview: {
        ...overview([]),
        sessions: [
          { id: 's1', name: 's1', status: 'idle', shared: false, diskBytes: Number.NaN, ahead: 'many', changed: -3, createdAt: 'x', lastActiveAt: 'y' },
          { name: 'no id' }, { id: 'no name' }, null, 7,
        ],
      } }],
    })
    const p = parsed.projects[0]
    expect(p?.state).toBe('ok')
    const rows = p?.state === 'ok' ? p.overview.sessions : []
    expect(rows).toHaveLength(1)
    expect(rows[0]?.diskBytes).toBeNull()
    expect(rows[0]?.ahead).toBeNull()
    expect(rows[0]?.changed).toBeNull()
  })

  test('per-day maps keep only YYYY-MM-DD keys with whole non-negative counts', () => {
    const parsed = parseDashboard({ projects: [{ root: '/p', name: 'p', state: 'ok', overview: { ...overview([]), startedPerDay: { '2026-09-30': 2, 'junk': 5, '2026-09-29': -1, '2026-09-28': 1.5 } } }] })
    const p = parsed.projects[0]
    expect(p?.state === 'ok' ? p.overview.startedPerDay : null).toEqual({ '2026-09-30': 2 })
  })
})

describe('summarize', () => {
  test('counts sessions by state, sums what was measured, and says how much is still unknown', () => {
    const d = data([
      project('/a', [session({ id: 'r', status: 'running', diskBytes: 1000 }), session({ id: 'i', status: 'idle', diskBytes: 2000 }), session({ id: 'x', status: 'landed', diskBytes: 4000, diskApprox: true }), session({ id: 'm', diskBytes: null, diskMeasuring: true }), session({ id: 'sh', shared: true, diskBytes: null })], { running: 1 }),
      { root: '/old', name: 'old', state: 'needs-restart' },
    ], { memoryBytes: 300 * 1024 * 1024, cpuPercent: 12, processes: 5 })
    const s = summarize(d)
    expect(s.projects).toBe(2)
    expect(s.sessions).toEqual({ running: 1, stopped: 3, ended: 1, total: 5 })
    expect(s.diskBytes).toBe(7000)
    expect(s.diskUnmeasured).toBe(1) // the shared one is not "unmeasured": it has no disk of its own
    expect(s.diskApprox).toBe(true)
    expect(s.needsRestart).toBe(1)
    expect(s.memoryBytes).toBe(300 * 1024 * 1024 + 80 * 1024 * 1024)
  })

  test('an empty window is zeros and dashes, not NaN', () => {
    const s = summarize(data([]))
    expect(s).toMatchObject({ projects: 0, diskBytes: 0, diskUnmeasured: 0, needsRestart: 0 })
    expect(s.sessions).toEqual({ running: 0, stopped: 0, ended: 0, total: 0 })
    expect(s.memoryBytes).toBeNull()
  })
})

describe('projectRows and sessionRows', () => {
  test('one row per project with its daemon memory; a project that cannot be read still has a row', () => {
    const rows = projectRows(data([project('/a', [session({ id: 'x', diskBytes: 10 })]), { root: '/b', name: 'b', state: 'unreachable', message: 'down' }]))
    expect(rows.map((r) => [r.name, r.state, r.diskBytes, r.memoryBytes])).toEqual([['a', 'ok', 10, 80 * 1024 * 1024], ['b', 'unreachable', null, null]])
  })

  test('two projects with the same folder name are told apart by their location', () => {
    const rows = projectRows(data([project('/x/app', []), project('/y/app', [])]))
    expect(new Set(rows.map((r) => r.label)).size).toBe(2)
  })

  test('sessions across projects, biggest disk first, unmeasured last, stable on ties', () => {
    const d = data([project('/a', [session({ id: 'small', diskBytes: 5 }), session({ id: 'none', diskBytes: null })]), project('/b', [session({ id: 'big', diskBytes: 50 }), session({ id: 'mid', diskBytes: 5 })])])
    expect(sessionRows(d, 'disk').map((r) => r.session.id)).toEqual(['big', 'mid', 'small', 'none'])
  })

  test('sorted by name or by last activity when asked', () => {
    const d = data([project('/a', [session({ id: 'b', lastActiveAt: ago(1 * DAY) }), session({ id: 'a', lastActiveAt: ago(9 * DAY) })])])
    expect(sessionRows(d, 'name').map((r) => r.session.id)).toEqual(['a', 'b'])
    expect(sessionRows(d, 'activity').map((r) => r.session.id)).toEqual(['b', 'a']) // most recently active first
  })
})

describe('suggestions', () => {
  test('ended sessions that still hold a worktree become ONE safe clean-up per project, with what it would reclaim', () => {
    const d = data([project('/a', [session({ id: 'd1', status: 'dead', diskBytes: 3000 }), session({ id: 'l1', status: 'landed', diskBytes: 1000 }), session({ id: 'run', status: 'running' })])])
    const gc = suggestions(d, NOW).filter((s) => s.kind === 'cleanup')
    expect(gc).toHaveLength(1)
    expect(gc[0]).toMatchObject({ projectRoot: '/a', reclaimBytes: 4000, danger: 'safe' })
    expect(gc[0]?.sessionIds.sort()).toEqual(['d1', 'l1'])
  })

  test('a clean-up says so when some ended sessions hold unlanded work (gc keeps those)', () => {
    const d = data([project('/a', [session({ id: 'd1', status: 'dead', diskBytes: 3000, ahead: 2 }), session({ id: 'd2', status: 'dead', diskBytes: 1000 })])])
    const gc = suggestions(d, NOW).find((s) => s.kind === 'cleanup')
    expect(gc?.reason).toContain('keeps')
    expect(gc?.reclaimBytes).toBe(1000)
  })

  test('uncommitted files keep a killed session out of a clean-up too (gc keeps it), and unknown counts are not promised', () => {
    const d = data([project('/a', [
      session({ id: 'dirty', status: 'dead', diskBytes: 3000, changed: 1 }),
      session({ id: 'unknown', status: 'dead', diskBytes: 2000, ahead: null, changed: null }),
      session({ id: 'clean', status: 'dead', diskBytes: 1000 }),
    ])])
    const gc = suggestions(d, NOW).find((s) => s.kind === 'cleanup')
    expect(gc?.sessionIds).toEqual(['clean'])
    expect(gc?.reclaimBytes).toBe(1000)
    const onlyDirty = data([project('/a', [session({ id: 'dirty', status: 'dead', changed: 1 })])])
    expect(suggestions(onlyDirty, NOW).some((s) => s.kind === 'cleanup')).toBe(false)
  })

  test('a shared session (the project folder) and an ended session with no worktree are never counted', () => {
    const d = data([project('/a', [session({ id: 'sh', status: 'dead', shared: true, worktreePath: '/a', diskBytes: 9999 }), session({ id: 'nowt', status: 'dead', worktreePath: null, diskBytes: null })])])
    expect(suggestions(d, NOW)).toEqual([])
  })

  test(`a stopped session with nothing to lose, untouched for ${STALE_EMPTY_DAYS} days, is a delete suggestion`, () => {
    const d = data([project('/a', [
      session({ id: 'old', lastActiveAt: ago((STALE_EMPTY_DAYS + 1) * DAY), diskBytes: 900 * 1024 * 1024 }),
      session({ id: 'recent', lastActiveAt: ago((STALE_EMPTY_DAYS - 1) * DAY) }),
    ])])
    const list = suggestions(d, NOW).filter((s) => s.kind === 'delete')
    expect(list.map((s) => s.sessionIds)).toEqual([['old']])
    expect(list[0]).toMatchObject({ danger: 'confirm', reclaimBytes: 900 * 1024 * 1024, consequences: { ahead: 0, changed: 0 } })
  })

  test('a stale empty session that frees next to nothing, or has not been measured yet, is not worth suggesting', () => {
    const d = data([project('/a', [
      session({ id: 'tiny', lastActiveAt: ago(30 * DAY), diskBytes: MIN_DELETE_BYTES - 1 }),
      session({ id: 'unmeasured', lastActiveAt: ago(30 * DAY), diskBytes: null, diskMeasuring: true }),
      session({ id: 'enough', lastActiveAt: ago(30 * DAY), diskBytes: MIN_DELETE_BYTES }),
    ])])
    expect(suggestions(d, NOW).filter((s) => s.kind === 'delete').map((s) => s.sessionIds)).toEqual([['enough']])
  })

  test('it will not call a session empty when it cannot prove it: unknown counts are never "nothing to lose"', () => {
    const d = data([project('/a', [session({ id: 'u1', lastActiveAt: ago(30 * DAY), ahead: null, changed: 0 }), session({ id: 'u2', lastActiveAt: ago(30 * DAY), ahead: 0, changed: null })])])
    expect(suggestions(d, NOW).filter((s) => s.kind === 'delete')).toEqual([])
  })

  test(`unlanded work idle for ${STALE_UNLANDED_DAYS} days is a separate, louder suggestion that names what would be lost`, () => {
    const d = data([project('/a', [
      session({ id: 'work', lastActiveAt: ago((STALE_UNLANDED_DAYS + 1) * DAY), ahead: 3, changed: 2, diskBytes: 5000 }),
      session({ id: 'young', lastActiveAt: ago((STALE_UNLANDED_DAYS - 1) * DAY), ahead: 3, changed: 2 }),
    ])])
    const list = suggestions(d, NOW).filter((s) => s.kind === 'unlanded')
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ danger: 'unlanded', sessionIds: ['work'], consequences: { ahead: 3, changed: 2 } })
    expect(list[0]?.reason).toContain('3 commits')
  })

  test(`a running shell with no agent, idle for ${IDLE_SHELL_HOURS} hours, is offered a stop; a running agent or a busy shell never is`, () => {
    const hr = 3_600_000
    const d = data([project('/a', [
      session({ id: 'idle', status: 'running', agent: null, activity: 'idle', lastActivityAt: NOW - (IDLE_SHELL_HOURS + 1) * hr }),
      session({ id: 'agent', status: 'running', agent: 'claude', activity: 'idle', lastActivityAt: NOW - 99 * hr }),
      session({ id: 'busy', status: 'running', agent: null, activity: 'working', lastActivityAt: NOW - 99 * hr }),
      session({ id: 'fresh', status: 'running', agent: null, activity: 'idle', lastActivityAt: NOW - (IDLE_SHELL_HOURS - 1) * hr }),
    ])])
    const list = suggestions(d, NOW).filter((s) => s.kind === 'stop')
    expect(list.map((s) => s.sessionIds)).toEqual([['idle']])
    expect(list[0]?.reclaimBytes).toBeNull()
  })

  test('the age falls back to the row\'s last-active time, and a session whose age cannot be known is left alone', () => {
    const d = data([project('/a', [
      session({ id: 'ok', lastActivityAt: null, lastActiveAt: ago(30 * DAY) }),
      session({ id: 'broken', lastActivityAt: null, lastActiveAt: 'not a date', createdAt: 'nope' }),
    ])])
    expect(suggestions(d, NOW).filter((s) => s.kind === 'delete').map((s) => s.sessionIds)).toEqual([['ok']])
  })

  test('biggest reclaim first, unknown sizes last, ties by name; a session is suggested once', () => {
    const MB = 1024 * 1024
    const d = data([project('/a', [
      session({ id: 'small', lastActiveAt: ago(30 * DAY), diskBytes: 6 * MB }),
      session({ id: 'big', lastActiveAt: ago(30 * DAY), diskBytes: 90 * MB }),
      session({ id: 'gone', status: 'dead', diskBytes: 50 * MB }),
      session({ id: 'idle-shell', status: 'running', agent: null, activity: 'idle', lastActivityAt: NOW - 30 * 3_600_000, diskBytes: 1 }),
    ])])
    const list = suggestions(d, NOW)
    expect(list.map((s) => s.kind + ':' + s.sessionIds.join(','))).toEqual(['delete:big', 'cleanup:gone', 'delete:small', 'stop:idle-shell'])
    const ids = list.flatMap((s) => s.sessionIds)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('a project whose daemon is old or unreachable produces no suggestion', () => {
    expect(suggestions(data([{ root: '/o', name: 'o', state: 'needs-restart' }, { root: '/u', name: 'u', state: 'unreachable', message: 'x' }]), NOW)).toEqual([])
  })
})

describe('charts', () => {
  test('disk by project: measured projects, biggest first; nothing measured is an empty chart', () => {
    const d = data([project('/a', [session({ id: 'x', diskBytes: 10 })]), project('/b', [session({ id: 'y', diskBytes: 90 })]), project('/c', [session({ id: 'z', diskBytes: null })])])
    expect(diskByProject(d).map((b) => [b.name, b.bytes])).toEqual([['b', 90], ['a', 10]])
    expect(diskByProject(data([]))).toEqual([])
  })

  test('per-day series: 14 days oldest first, zero-filled, summed across projects, out-of-window days ignored', () => {
    const today = '2026-09-30'
    const d = data([
      project('/a', [], { startedPerDay: { [today]: 2, '2026-09-29': 1, '2025-01-01': 9 }, landedPerDay: { [today]: 1 } }),
      project('/b', [], { startedPerDay: { [today]: 3 } }),
    ])
    const series = perDaySeries(d, NOW)
    expect(series).toHaveLength(14)
    expect(series[0]?.day).toBe('2026-09-17')
    expect(series[13]).toEqual({ day: today, started: 5, landed: 1 })
    expect(series[12]).toMatchObject({ day: '2026-09-29', started: 1, landed: 0 })
    expect(series.reduce((n, s) => n + s.started, 0)).toBe(6)
  })
})
