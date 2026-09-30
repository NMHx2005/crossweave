/** @jsxImportSource preact */
import { describe, expect, test } from 'bun:test'
import type { ComponentChildren, VNode } from 'preact'
import { DashboardView, SESSIONS_SHOWN, stateOf, type DashboardViewProps } from '../src/ui/SettingsDashboard'
import { DayBars, DiskBars } from '../src/ui/DashCharts'
import { ConfirmDialog } from '../src/ui/ConfirmDialog'
import type { DashboardData, ProjectEntry, SessionStat } from '../src/lib/dashboard'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 8, 30, 12, 0, 0)
const ago = (ms: number): string => new Date(NOW - ms).toISOString()

const session = (over: Partial<SessionStat> & { id: string }): SessionStat => ({
  name: over.id, status: 'idle', branch: `cw/${over.id}`, worktreePath: `/wt/${over.id}`, shared: false, agent: null, activity: 'idle',
  createdAt: ago(30 * DAY), lastActiveAt: ago(30 * DAY), lastActivityAt: null, diskBytes: 100 * 1024 * 1024, diskApprox: false, diskMeasuring: false,
  ahead: 0, changed: 0, tokens: null, costUsd: 0, ...over,
})

const okProject = (root: string, sessions: SessionStat[]): ProjectEntry => ({
  root, name: root.split('/').pop() as string, state: 'ok',
  overview: {
    workspaceId: 'ws', root, measuredAt: NOW, process: { pid: 1, uptimeMs: 1000, rssBytes: 80 * 1024 * 1024, heapUsedBytes: 1 },
    running: 0, terminals: 0, limits: { perSessionBytes: 1e10, perWorkspaceBytes: 1e11 }, sessions, startedPerDay: {}, landedPerDay: {},
  },
})
const data = (projects: ProjectEntry[]): DashboardData => ({ projects, app: null, at: NOW })

const base = (over: Partial<DashboardViewProps> = {}): DashboardViewProps => ({
  data: null, loading: false, error: null, notice: null, now: NOW, sort: 'disk', showAll: false, isBusy: () => false,
  onRefresh: () => {}, onSort: () => {}, onShowAll: () => {}, onSuggestion: () => {}, onStop: () => {}, onDelete: () => {}, ...over,
})

/** Components with their own state or a portal are left as leaves; every other one is expanded, so the walk sees what the user would. */
const OPAQUE = new Set<unknown>([DiskBars, DayBars, ConfirmDialog])
type Found = { texts: string[]; nodes: VNode[] }
function walk(node: ComponentChildren, out: Found = { texts: [], nodes: [] }): Found {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') { out.texts.push(String(node)); return out }
  if (Array.isArray(node)) { for (const n of node) walk(n, out); return out }
  const v = node as VNode<Record<string, unknown>>
  out.nodes.push(v)
  if (typeof v.type === 'function' && !OPAQUE.has(v.type)) return walk((v.type as (p: unknown) => ComponentChildren)(v.props), out)
  return walk(v.props['children'] as ComponentChildren, out)
}
const view = (over: Partial<DashboardViewProps> = {}): Found => walk(DashboardView(base(over)))
// JSX splits `{n} word` into two strings; a reader sees one, so compare on collapsed whitespace.
const text = (f: Found): string => f.texts.join(' ').replace(/\s+/g, ' ')
const buttons = (f: Found, label: string): VNode[] => f.nodes.filter((n) => n.type === 'button' && walk(n).texts.join('').includes(label))

describe('DashboardView states', () => {
  test('loading with nothing yet says so and offers a disabled Refresh', () => {
    const f = view({ loading: true })
    expect(text(f)).toContain('Reading your projects')
    expect(buttons(f, 'Refresh')[0]?.props.disabled).toBe(true)
  })

  test('a failed request is an alert with Try again, and no numbers', () => {
    const calls: number[] = []
    const f = view({ error: 'The daemon did not answer.', onRefresh: () => calls.push(1) })
    expect(text(f)).toContain('The daemon did not answer.')
    expect(f.nodes.some((n) => n.props['role'] === 'alert')).toBe(true)
    buttons(f, 'Try again')[0]?.props.onClick()
    expect(calls).toEqual([1])
    expect(text(f)).not.toContain('Overview')
  })

  test('no project open is explained, not blank', () => {
    expect(text(view({ data: data([]) }))).toContain('No project is open')
  })

  test('an old daemon is named in a notice and on its own row, and the other projects still show', () => {
    const d = data([okProject('/a', [session({ id: 's1' })]), { root: '/old', name: 'old', state: 'needs-restart' }])
    const t = text(view({ data: d }))
    expect(t).toContain('1 project runs a daemon older than this app')
    expect(t).toContain('restart it to see its numbers')
    expect(t).toContain('s1')
  })

  test('a silent daemon shows its message on the row', () => {
    const d = data([okProject('/a', []), { root: '/down', name: 'down', state: 'unreachable', message: 'It did not answer in time.' }])
    const f = view({ data: d })
    expect(text(f)).toContain('It did not answer in time.')
    expect(text(f)).toContain('1 not answering')
  })

  test('unmeasured worktrees say "measuring" rather than showing a fake size', () => {
    const d = data([okProject('/a', [session({ id: 's1', diskBytes: null, diskMeasuring: true })])])
    const t = text(view({ data: d }))
    expect(t).toContain('1 still measuring')
    expect(t).toContain('measuring…')
  })

  test('nothing to suggest is a calm sentence', () => {
    const d = data([okProject('/a', [session({ id: 's1', lastActiveAt: ago(1000) })])])
    expect(text(view({ data: d }))).toContain('Nothing to suggest')
  })

  test('a notice is a status, an error notice is an alert', () => {
    const d = data([okProject('/a', [])])
    const ok = view({ data: d, notice: { text: 'Deleted x.', error: false } })
    expect(ok.nodes.find((n) => n.props['role'] === 'status' && walk(n).texts.join('') === 'Deleted x.')).toBeDefined()
    const bad = view({ data: d, notice: { text: 'Could not delete x.', error: true } })
    expect(bad.nodes.find((n) => n.props['role'] === 'alert' && walk(n).texts.join('') === 'Could not delete x.')).toBeDefined()
  })
})

describe('DashboardView sessions', () => {
  const many = Array.from({ length: SESSIONS_SHOWN + 3 }, (_, i) => session({ id: `s${String(i).padStart(2, '0')}`, lastActiveAt: ago(1000) }))

  test('long lists are cut, with a control to show them all', () => {
    const d = data([okProject('/a', many)])
    const cut = view({ data: d, sort: 'name' })
    expect(cut.nodes.filter((n) => n.props['data-session'] !== undefined)).toHaveLength(SESSIONS_SHOWN)
    expect(buttons(cut, `Show all ${many.length}`)).toHaveLength(1)
    const all = view({ data: d, sort: 'name', showAll: true })
    expect(all.nodes.filter((n) => n.props['data-session'] !== undefined)).toHaveLength(many.length)
    expect(buttons(all, 'Show fewer')).toHaveLength(1)
  })

  test('a shared session shows no size and says it works in the project folder', () => {
    const d = data([okProject('/a', [session({ id: 'sh', shared: true, worktreePath: '/a', diskBytes: null })])])
    const t = text(view({ data: d }))
    expect(t).toContain('works in the project folder')
    expect(t).toContain('—')
    expect(t).not.toContain('measuring…')
  })

  test('only a running session can be stopped; every session can be deleted', () => {
    const d = data([okProject('/a', [session({ id: 'run', status: 'running' }), session({ id: 'done', status: 'landed' })])])
    const f = view({ data: d, sort: 'name' })
    const rows = f.nodes.filter((n) => n.props['data-session'] !== undefined)
    const of = (id: string) => walk(rows.find((r) => r.props['data-session'] === id))
    expect(buttons(of('run'), 'Stop…')).toHaveLength(1)
    expect(buttons(of('done'), 'Stop…')).toHaveLength(0)
    expect(buttons(of('done'), 'Delete…')).toHaveLength(1)
  })

  test('a session with an action under way has its buttons disabled', () => {
    const d = data([okProject('/a', [session({ id: 'x', status: 'running' })])])
    const f = view({ data: d, isBusy: (id) => id === 'x' })
    const row = walk(f.nodes.find((r) => r.props['data-session'] === 'x'))
    expect(buttons(row, 'Delete…')[0]?.props.disabled).toBe(true)
    expect(buttons(row, 'Stop…')[0]?.props.disabled).toBe(true)
  })
})

describe('DashboardView suggestions', () => {
  const stale = (id: string, over: Partial<SessionStat> = {}) => session({ id, lastActiveAt: ago(20 * DAY), createdAt: ago(20 * DAY), ...over })

  test('only the proposal that can lose unlanded work is styled as dangerous', () => {
    const d = data([okProject('/a', [stale('empty'), stale('work', { ahead: 2 })])])
    const f = view({ data: d })
    const cards = f.nodes.filter((n) => n.props['data-suggestion'] !== undefined)
    expect(cards.length).toBeGreaterThanOrEqual(2)
    const danger = cards.filter((c) => buttons(walk(c), '…').some((b) => String(b.props.class).includes('cockpit-btn--danger')))
    expect(danger).toHaveLength(1)
    expect(text(walk(danger[0]))).toContain('unlanded work')
  })

  test('the suggestion button hands its proposal back', () => {
    const d = data([okProject('/a', [stale('empty')])])
    const got: string[] = []
    const f = view({ data: d, onSuggestion: (s) => got.push(s.kind) })
    const card = f.nodes.find((n) => n.props['data-suggestion'] !== undefined)
    buttons(walk(card), '…')[0]?.props.onClick()
    expect(got).toEqual(['delete'])
  })
})

describe('stateOf', () => {
  test('running and waiting count as running; landed and dead as ended; anything else stopped', () => {
    expect(stateOf('running')).toBe('running')
    expect(stateOf('waiting')).toBe('running')
    expect(stateOf('landed')).toBe('ended')
    expect(stateOf('dead')).toBe('ended')
    expect(stateOf('idle')).toBe('stopped')
    expect(stateOf('whatever')).toBe('stopped')
  })
})
