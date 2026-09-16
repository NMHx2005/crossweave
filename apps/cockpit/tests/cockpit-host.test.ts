import { describe, expect, test } from 'bun:test'
import { blockedSessionFromEvent } from '../src/lib/attention'
import {
  createAndStartSession,
  loadWorkspace,
  stageStatusAfterFailure,
  subscribeCockpitHost,
} from '../src/lib/cockpit-host'
import { parseSessionList } from '../src/lib/sessions'

function fakeApi(opts?: { resumeId?: string }) {
  const calls: string[] = []
  const listeners: {
    invalidate?: (payload: unknown) => void
    event?: (payload: unknown) => void
    gone?: (payload: unknown) => void
  } = {}
  const api = {
    ensureWorkspace: async () => {
      calls.push('ensure')
      return { projectRoot: '/tmp/demo', workspace: { id: 'ws_1', name: 'demo', rootPath: '/tmp/demo' } }
    },
    listSessions: async () => {
      calls.push('list')
      return parseSessionList([{ id: 's1', name: 'alpha', status: 'running' }])
    },
    convergeStatus: async () => {
      calls.push('converge')
      return { ready: ['alpha'], unknown: [], blocked: [] }
    },
    newSession: async (payload: { name: string; agent: string }) => {
      calls.push(`new:${payload.name}:${payload.agent}`)
      return { id: 's9', name: payload.name, status: 'idle' }
    },
    resumeSession: async (idOrName: string) => {
      calls.push(`resume:${idOrName}`)
      return { id: opts?.resumeId ?? idOrName, status: 'running' }
    },
    startSession: async (idOrName: string) => {
      calls.push(`start:${idOrName}`)
      return { id: idOrName, status: 'running' }
    },
    onTuiInvalidate: (cb: (payload: unknown) => void) => {
      listeners.invalidate = cb
      return () => {
        listeners.invalidate = undefined
      }
    },
    onTuiEvent: (cb: (payload: unknown) => void) => {
      listeners.event = cb
      return () => {
        listeners.event = undefined
      }
    },
    onDaemonGone: (cb: (payload: unknown) => void) => {
      listeners.gone = cb
      return () => {
        listeners.gone = undefined
      }
    },
  }
  return { api, calls, listeners }
}

describe('loadWorkspace + daemon.gone', () => {
  test('refresh after daemon.gone calls ensureWorkspace then list', async () => {
    const { api, calls, listeners } = fakeApi()
    let refreshDone: Promise<unknown> = Promise.resolve()
    subscribeCockpitHost(api, {
      refresh: () => {
        refreshDone = loadWorkspace(api)
      },
    })
    expect(listeners.gone).toBeTypeOf('function')
    listeners.gone?.({})
    const loaded = await refreshDone
    expect(calls).toEqual(['ensure', 'list', 'converge'])
    expect(loaded.sessions).toEqual([{ id: 's1', name: 'alpha', status: 'running' }])
  })
})

describe('createAndStartSession', () => {
  test('session.new is followed by session.resume so the pane can attach', async () => {
    const { api, calls } = fakeApi()
    const created = await createAndStartSession(api, { name: 'beta', agent: 'claude' })
    expect(calls).toEqual(['new:beta:claude', 'resume:s9'])
    expect(created).toEqual({ id: 's9', name: 'beta', status: 'idle' })
  })

  test('falls back to the prompted name when new returns no id', async () => {
    const { api, calls } = fakeApi()
    api.newSession = async (payload) => {
      calls.push(`new:${payload.name}:${payload.agent}`)
      return { name: payload.name }
    }
    await createAndStartSession(api, { name: 'gamma', agent: 'cursor' })
    expect(calls).toEqual(['new:gamma:cursor', 'resume:gamma'])
  })
})

describe('stageStatusAfterFailure', () => {
  test('keeps ready when sessions exist so action errors do not unmount panes', () => {
    expect(stageStatusAfterFailure(2)).toBe('ready')
    expect(stageStatusAfterFailure(1)).toBe('ready')
  })

  test('uses error when there are no sessions to keep on stage', () => {
    expect(stageStatusAfterFailure(0)).toBe('error')
  })
})

describe('subscribeCockpitHost tui.event', () => {
  test('blocked tui.event still refreshes without dropping the host subscription', async () => {
    const { api, calls, listeners } = fakeApi()
    const events: unknown[] = []
    let refreshDone: Promise<unknown> = Promise.resolve()
    subscribeCockpitHost(api, {
      refresh: () => {
        refreshDone = loadWorkspace(api)
      },
      onEvent: (payload) => {
        events.push(blockedSessionFromEvent(payload))
      },
    })
    listeners.event?.({ kind: 'blocked', session: 'auth' })
    await refreshDone
    expect(events).toEqual(['auth'])
    expect(calls).toEqual(['ensure', 'list', 'converge'])
  })

  test('invalidate and gone are distinct from event so blocked names can be cleared', () => {
    const { api, listeners } = fakeApi()
    const sources: string[] = []
    subscribeCockpitHost(api, {
      refresh: (source) => {
        sources.push(source)
      },
    })
    listeners.invalidate?.({})
    listeners.event?.({ kind: 'blocked', session: 'auth' })
    listeners.gone?.({})
    expect(sources).toEqual(['invalidate', 'event', 'gone'])
  })
})
