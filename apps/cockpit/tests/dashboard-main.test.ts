import { describe, expect, test } from 'bun:test'
import { collectDashboard, type DashboardDeps } from '../electron/dashboard'
import { CrossweaveError } from '../../../src/core/errors'

const okAnswer = { workspaceId: 'ws', root: '/p', measuredAt: 1, process: { pid: 1, uptimeMs: 1, rssBytes: 5, heapUsedBytes: 1 }, running: 0, terminals: 0, limits: { perSessionBytes: 1, perWorkspaceBytes: 1 }, sessions: [], startedPerDay: {}, landedPerDay: {} }

function deps(over: Partial<DashboardDeps> = {}): DashboardDeps {
  return {
    roots: async () => ['/a', '/b'],
    overview: async () => okAnswer,
    metrics: () => [{ type: 'Browser', memoryKb: 1000, cpu: 2 }, { type: 'Tab', memoryKb: 3000, cpu: 5.5 }],
    now: () => 42,
    ...over,
  }
}

describe('collectDashboard', () => {
  test('one entry per open project, with the app\'s own memory and CPU summed', async () => {
    const d = (await collectDashboard(deps())) as { projects: Array<{ root: string; state: string }>; app: { memoryBytes: number; cpuPercent: number; processes: number }; at: number }
    expect(d.projects.map((p) => [p.root, p.state])).toEqual([['/a', 'ok'], ['/b', 'ok']])
    expect(d.app).toEqual({ memoryBytes: 4000 * 1024, cpuPercent: 7.5, processes: 2 })
    expect(d.at).toBe(42)
  })

  test('a daemon that predates the dashboard is "needs-restart", not an error', async () => {
    const d = (await collectDashboard(deps({ overview: async (root) => { if (root === '/a') throw new CrossweaveError('METHOD_NOT_FOUND', 'Unknown method: stats.overview'); return okAnswer } }))) as { projects: Array<{ state: string }> }
    expect(d.projects.map((p) => p.state)).toEqual(['needs-restart', 'ok'])
  })

  test('an unknown-method message with a different code is still recognised as an old daemon', async () => {
    const d = (await collectDashboard(deps({ roots: async () => ['/a'], overview: async () => { throw new Error('RPC_ERROR: Unknown method: stats.overview') } }))) as { projects: Array<{ state: string }> }
    expect(d.projects[0]?.state).toBe('needs-restart')
  })

  test('a project whose daemon does not answer in time is "unreachable" and the others still come back', async () => {
    const d = (await collectDashboard(deps({
      timeoutMs: 20,
      overview: (root) => (root === '/a' ? new Promise(() => undefined) : Promise.resolve(okAnswer)),
    }))) as { projects: Array<{ root: string; state: string; message?: string }> }
    expect(d.projects[0]).toMatchObject({ root: '/a', state: 'unreachable' })
    expect(d.projects[0]?.message).toContain('did not answer')
    expect(d.projects[1]?.state).toBe('ok')
  })

  test('any other failure is "unreachable" with a fixed sentence: no message, path or stack from the error reaches the window', async () => {
    const d = (await collectDashboard(deps({ roots: async () => ['/a'], overview: async () => { throw new CrossweaveError('WORKSPACE_NOT_FOUND', 'No such workspace at /Users/secret/place') } }))) as { projects: Array<{ state: string; message?: string }> }
    expect(d.projects[0]?.state).toBe('unreachable')
    expect(d.projects[0]?.message).toContain('WORKSPACE_NOT_FOUND')
    expect(d.projects[0]?.message).not.toContain('/Users/secret')
    const plain = (await collectDashboard(deps({ roots: async () => ['/a'], overview: async () => { throw new Error('boom at /Users/secret/x.ts:1') } }))) as { projects: Array<{ message?: string }> }
    expect(plain.projects[0]?.message).not.toContain('/Users/secret')
  })

  test('no open project is an empty list, and the app figures still come', async () => {
    const d = (await collectDashboard(deps({ roots: async () => [] }))) as { projects: unknown[]; app: unknown }
    expect(d.projects).toEqual([])
    expect(d.app).not.toBeNull()
  })

  test('if the list of projects or the app metrics cannot be read, the window still gets an answer', async () => {
    const a = (await collectDashboard(deps({ roots: async () => { throw new Error('no bridge') } }))) as { projects: unknown[]; app: unknown }
    expect(a.projects).toEqual([])
    const b = (await collectDashboard(deps({ metrics: () => { throw new Error('no metrics') } }))) as { app: unknown }
    expect(b.app).toBeNull()
  })

  test('non-finite or negative metrics never poison the totals', async () => {
    const d = (await collectDashboard(deps({ metrics: () => [{ type: 'x', memoryKb: Number.NaN, cpu: -3 }, { type: 'y', memoryKb: 10, cpu: 1 }] }))) as { app: { memoryBytes: number; cpuPercent: number } }
    expect(d.app.memoryBytes).toBe(10 * 1024)
    expect(d.app.cpuPercent).toBe(1)
  })

  test('the projects are asked at the same time, not one after another', async () => {
    let live = 0
    let peak = 0
    await collectDashboard(deps({ roots: async () => ['/a', '/b', '/c'], overview: async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 15)); live--; return okAnswer } }))
    expect(peak).toBe(3)
  })

  test('more projects than the cap are not all asked at once', async () => {
    let live = 0
    let peak = 0
    const roots = Array.from({ length: 20 }, (_, i) => `/p${i}`)
    await collectDashboard(deps({ roots: async () => roots, overview: async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 5)); live--; return okAnswer } }))
    expect(peak).toBeLessThanOrEqual(8)
  })
})
