import { describe, expect, test } from 'bun:test'
import { blockedSessionFromEvent } from '../src/lib/attention'
import {
  loadWorkspace,
  parseJournalTabs,
  plainErrorMessage,
  runCockpitAction,
  shouldBumpPaneAttach,
  stageStatusAfterFailure,
  subscribeCockpitHost,
} from '../src/lib/cockpit-host'
import { parseSessionList } from '../src/lib/sessions'

function fakeApi(opts?: { resumeId?: string; journalTabs?: unknown }) {
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
    journalGet: async () => {
      calls.push('journal')
      return { openTabs: opts?.journalTabs ?? [] }
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

describe('shouldBumpPaneAttach', () => {
  test('bumps only after daemon.gone reconnect refresh', () => {
    expect(shouldBumpPaneAttach('gone')).toBe(true)
    expect(shouldBumpPaneAttach('invalidate')).toBe(false)
    expect(shouldBumpPaneAttach('event')).toBe(false)
  })
})

describe('runCockpitAction', () => {
  test('refreshes after a successful action', async () => {
    const refreshModes: boolean[] = []
    const error = await runCockpitAction(
      async () => undefined,
      async (partialFailure) => {
        refreshModes.push(partialFailure)
      },
    )
    expect(error).toBeUndefined()
    expect(refreshModes).toEqual([false])
  })

  test('still refreshes when the action throws so partial failures show new rows', async () => {
    const refreshModes: boolean[] = []
    const error = await runCockpitAction(
      async () => {
        throw new Error('resume failed')
      },
      async (partialFailure) => {
        refreshModes.push(partialFailure)
      },
    )
    expect(error).toBe('resume failed')
    expect(refreshModes).toEqual([true])
  })

  test('session.new then resume failure still leaves refresh as the recovery path', async () => {
    const { api, calls } = fakeApi()
    api.resumeSession = async (idOrName: string) => {
      calls.push(`resume:${idOrName}`)
      throw new Error('resume failed')
    }
    const refreshCalls: string[] = []
    const error = await runCockpitAction(
      async () => {
        await api.newSession({ name: 'delta', agent: 'claude' })
        await api.resumeSession('s9')
      },
      async (partialFailure) => {
        refreshCalls.push(partialFailure ? 'partial' : 'full')
        if (partialFailure) await loadWorkspace(api)
      },
    )
    expect(error).toBe('resume failed')
    expect(calls).toEqual(['new:delta:claude', 'resume:s9', 'ensure', 'list', 'converge', 'journal'])
    expect(refreshCalls).toEqual(['partial'])
  })
})

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
    expect(calls).toEqual(['ensure', 'list', 'converge', 'journal'])
    expect(loaded.sessions).toEqual([{ id: 's1', name: 'alpha', status: 'running' }])
    expect(loaded.journalTabs).toEqual([])
  })

  test('a journal read failure costs the restore, not the load', async () => {
    const { api } = fakeApi()
    api.journalGet = async () => {
      throw new Error('journal.get is not a thing this daemon knows')
    }
    const loaded = await loadWorkspace(api)
    expect(loaded.journalTabs).toEqual([])
    expect(loaded.sessions.length).toBe(1)
  })
})

describe('journal restore', () => {
  test('parseJournalTabs tolerates anything that is not a tab list', () => {
    expect(parseJournalTabs({ openTabs: ['a', 2, null, 'b'] })).toEqual(['a', 'b'])
    expect(parseJournalTabs({ openTabs: 'a' })).toEqual([])
    expect(parseJournalTabs(undefined)).toEqual([])
    expect(parseJournalTabs({})).toEqual([])
  })

  test('loadWorkspace hands the restore order to the caller', async () => {
    const { api } = fakeApi({ journalTabs: ['s1'] })
    const loaded = await loadWorkspace(api)
    expect(loaded.journalTabs).toEqual(['s1'])
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
    expect(calls).toEqual(['ensure', 'list', 'converge', 'journal'])
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

describe('plainErrorMessage', () => {
  test('keeps only the daemon sentence from an invoke failure', () => {
    expect(plainErrorMessage(new Error("Error invoking remote method 'workspace.ensure': CrossweaveError: Daemon did not come up"))).toBe('Daemon did not come up')
    expect(plainErrorMessage(new Error('Error: plain'))).toBe('plain')
    expect(plainErrorMessage('a string')).toBe('a string')
  })
})
