import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { projectApi, withProjectRoot } from '../src/host/cockpit-api'

type Call = { channel: string; payload: unknown }
let calls: Call[]
let listeners: Map<string, Array<(payload: unknown) => void>>
const original = (globalThis as { window?: unknown }).window

beforeEach(() => {
  calls = []
  listeners = new Map()
  ;(globalThis as { window?: unknown }).window = {
    cockpit: {
      invoke: async (channel: string, payload?: unknown) => { calls.push({ channel, payload }); return [] },
      listen: (event: string, cb: (payload: unknown) => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), cb])
        return () => undefined
      },
    },
  }
})
afterEach(() => { (globalThis as { window?: unknown }).window = original })

const emit = (event: string, payload: unknown): void => { for (const cb of listeners.get(event) ?? []) cb(payload) }

describe('withProjectRoot', () => {
  test('stamps the root on a daemon call, keeps one the call already names', () => {
    expect(withProjectRoot('session.list', undefined, '/w/api')).toEqual({ projectRoot: '/w/api' })
    expect(withProjectRoot('session.input', { idOrName: 's', data: 'x' }, '/w/api')).toEqual({ idOrName: 's', data: 'x', projectRoot: '/w/api' })
    expect(withProjectRoot('session.list', { projectRoot: '/w/web' }, '/w/api')).toEqual({ projectRoot: '/w/web' })
  })

  // projects.close's root IS its argument; stamping the view's own would close the wrong one.
  test('leaves window-wide channels alone', () => {
    expect(withProjectRoot('projects.close', { projectRoot: '/w/web' }, '/w/api')).toEqual({ projectRoot: '/w/web' })
    expect(withProjectRoot('projects.list', undefined, '/w/api')).toBeUndefined()
    expect(withProjectRoot('app.badge', { count: 1 }, '/w/api')).toEqual({ count: 1 })
  })
})

describe('projectApi', () => {
  test("every call goes to the view's own project", async () => {
    const api = projectApi('/w/api')
    await api.listSessions()
    await api.sendInput('s1', 'ls\r')
    await api.resizeTerminal('t1', 80, 24)
    expect(calls).toEqual([
      { channel: 'session.list', payload: { projectRoot: '/w/api' } },
      { channel: 'session.input', payload: { idOrName: 's1', data: 'ls\r', projectRoot: '/w/api' } },
      { channel: 'terminal.resize', payload: { terminalId: 't1', cols: 80, rows: 24, projectRoot: '/w/api' } },
    ])
  })

  test("only the view's own project's events arrive", () => {
    const api = projectApi('/w/api')
    const seen: unknown[] = []
    api.onSessionData((p) => seen.push(p))
    emit('session.data', { sessionId: 's1', chunk: 'mine', projectRoot: '/w/api' })
    emit('session.data', { sessionId: 's9', chunk: 'theirs', projectRoot: '/w/web' })
    emit('session.data', { sessionId: 's9', chunk: 'untagged' })
    expect(seen).toEqual([{ sessionId: 's1', chunk: 'mine', projectRoot: '/w/api' }])
  })
})
