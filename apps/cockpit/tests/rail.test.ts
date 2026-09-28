import { describe, expect, test } from 'bun:test'
import { agentName, gitBadge, landChip, newlyAsking, railOrder, relativeTime, rowState, rowTitle, visibleRows, jumpTargets, clampMenu, newlyFinished, recentToOffer } from '../src/lib/rail'
import { parseSessionList } from '../src/lib/sessions'

describe('relativeTime', () => {
  test('now, minutes, hours, days — and nothing before any activity', () => {
    const now = 10_000_000_000
    expect(relativeTime(now - 5_000, now)).toBe('now')
    expect(relativeTime(now - 2 * 60_000, now)).toBe('2m')
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3h')
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2d')
    expect(relativeTime(null, now)).toBeUndefined()
  })
})

describe('rowTitle', () => {
  test("the user's note first, then what the agent last said, then the name", () => {
    expect(rowTitle({ name: 'api', latestWords: 'Tracing…', note: 'fix login' })).toBe('fix login')
    expect(rowTitle({ name: 'api', latestWords: "I'll trace the divider." })).toBe("I'll trace the divider.")
    expect(rowTitle({ name: 'api' })).toBe('api')
  })
})

describe('rowState', () => {
  test('an open shell shows its activity; a closed one says why', () => {
    expect(rowState({ status: 'running', activity: 'working' })).toBe('working')
    expect(rowState({ status: 'running', activity: 'asked' })).toBe('asked')
    expect(rowState({ status: 'running' })).toBe('idle')
    expect(rowState({ status: 'idle' })).toBe('stopped')
    expect(rowState({ status: 'idle', activity: 'failed' })).toBe('failed')
    expect(rowState({ status: 'landed' })).toBe('ended')
  })
})

describe('landChip', () => {
  test('only the verdicts worth acting on from the rail', () => {
    expect(landChip('ready')).toBe('ready')
    expect(landChip('conflict')).toBe('conflict')
    expect(landChip('working')).toBeUndefined()
    expect(landChip(undefined)).toBeUndefined()
  })
})

describe('agentName', () => {
  test('known agents by name, anything else as-is, none as Shell', () => {
    expect(agentName('claude')).toBe('Claude Code')
    expect(agentName('goose')).toBe('goose')
    expect(agentName('aider')).toBe('Aider')
    expect(agentName(null)).toBe('Shell')
  })
})

describe('railOrder', () => {
  test('asking first, then failed, working, idle, closed; newest first within', () => {
    const rows = [
      { id: 'a', name: 'a', status: 'idle' },
      { id: 'b', name: 'b', status: 'running', activity: 'working', lastActivityAt: 1 },
      { id: 'c', name: 'c', status: 'running', activity: 'asked' },
      { id: 'd', name: 'd', status: 'running', activity: 'working', lastActivityAt: 5 },
    ]
    expect(railOrder(rows).map((r) => r.id)).toEqual(['c', 'd', 'b', 'a'])
  })
})

describe('parseSessionList status fields', () => {
  test('keeps agent, activity and last activity from the daemon', () => {
    expect(parseSessionList([{ id: 's', name: 'a', agent: 'claude', activity: 'working', lastActivityAt: 7 }])[0])
      .toMatchObject({ agent: 'claude', activity: 'working', lastActivityAt: 7 })
    expect(parseSessionList([{ id: 's', name: 'a', agent: null }])[0]?.agent).toBeNull()
  })
})

describe('newlyAsking', () => {
  test('only a session seen starting to ask (it rang), not one already asking or first seen', () => {
    const prev = [{ id: 'a', activity: 'working' }, { id: 'b', activity: 'asked', rang: true }, { id: 'd', activity: 'asked', rang: false }]
    const next = [
      { id: 'a', name: 'a', activity: 'asked', rang: true },
      { id: 'b', name: 'b', activity: 'asked', rang: true },
      { id: 'c', name: 'c', activity: 'asked', rang: true },
      // Finished its turn, then rang: now it asks.
      { id: 'd', name: 'd', activity: 'asked', rang: true },
    ]
    expect(newlyAsking(prev, next).map((s) => s.id)).toEqual(['a', 'd'])
  })

  // An agent that went quiet after its turn without ringing has finished, not asked.
  test('quiet without a bell is not asking', () => {
    expect(newlyAsking([{ id: 'a', activity: 'working' }], [{ id: 'a', name: 'a', activity: 'asked', rang: false }])).toEqual([])
  })
})

describe('visibleRows', () => {
  const rows = parseSessionList([
    { id: 'a', name: 'api', status: 'running', latestWords: 'Tracing the divider', agent: 'claude', branch: 'cw/api' },
    { id: 'b', name: 'web', status: 'dead', branch: 'cw/web' },
    { id: 'c', name: 'old', status: 'landed' },
  ])
  const ids = (list: Array<{ id: string }>): string[] => list.map((s) => s.id)

  test('landed never; killed unless hidden', () => {
    expect(ids(visibleRows(rows))).toEqual(['a', 'b'])
    expect(ids(visibleRows(rows, { hideEnded: true }))).toEqual(['a'])
  })

  test('a filter matches name, last words, branch or agent, ignoring case', () => {
    expect(ids(visibleRows(rows, { query: 'WEB' }))).toEqual(['b'])
    expect(ids(visibleRows(rows, { query: 'divider' }))).toEqual(['a'])
    expect(ids(visibleRows(rows, { query: 'claude code' }))).toEqual(['a'])
    expect(ids(visibleRows(rows, { query: 'cw/' }))).toEqual(['a', 'b'])
    expect(ids(visibleRows(rows, { query: '   ' }))).toEqual(['a', 'b'])
    expect(visibleRows(rows, { query: 'nothing' })).toEqual([])
  })
})

describe('gitBadge', () => {
  test('files changed and commits to land; nothing when both are zero or unknown', () => {
    expect(gitBadge({ changed: 3, ahead: 2 })).toEqual({ changed: '3', ahead: '↑2', title: '3 uncommitted files · 2 commits to land' })
    expect(gitBadge({ changed: 1, ahead: null })).toEqual({ changed: '1', title: '1 uncommitted file' })
    expect(gitBadge({ changed: 0, ahead: 1 })).toEqual({ ahead: '↑1', title: '1 commit to land' })
    expect(gitBadge({ changed: 0, ahead: 0 })).toBeUndefined()
    expect(gitBadge(undefined)).toBeUndefined()
  })

  test('parsed from the daemon list', () => {
    expect(parseSessionList([{ id: 'a', name: 'a', git: { changed: 2, ahead: null } }])[0]?.git).toEqual({ changed: 2, ahead: null })
    expect(parseSessionList([{ id: 'a', name: 'a', git: { changed: 'x' } }])[0]?.git).toBeUndefined()
  })
})

describe('jumpTargets', () => {
  test('rows top to bottom across projects, in rail order, honoring hidden and filtered rows', () => {
    const api = parseSessionList([
      { id: 'a1', name: 'one', status: 'idle', lastActivityAt: 1 },
      { id: 'a2', name: 'two', status: 'running', activity: 'asked' },
      { id: 'a3', name: 'gone', status: 'dead' },
    ])
    const web = parseSessionList([{ id: 'w1', name: 'web', status: 'running' }])
    const groups = [{ projectRoot: '/api', sessions: api, hideEnded: true }, { projectRoot: '/web', sessions: web }]
    expect(jumpTargets(groups).map((t) => t.sessionId)).toEqual(['a2', 'a1', 'w1'])
    expect(jumpTargets(groups, 'web')).toEqual([{ projectRoot: '/web', sessionId: 'w1' }])
    expect(jumpTargets([])).toEqual([])
  })
})

describe('clampMenu', () => {
  test('stays inside the window, with a margin', () => {
    expect(clampMenu(100, 100, 200, 300, 1000, 800)).toEqual({ left: 100, top: 100 })
    expect(clampMenu(900, 700, 200, 300, 1000, 800)).toEqual({ left: 792, top: 492 })
    // Taller than the window: pinned to the top margin.
    expect(clampMenu(10, 10, 200, 900, 1000, 800)).toEqual({ left: 10, top: 8 })
  })
})

describe('newlyFinished', () => {
  const row = (id: string, activity: string, status = 'running', agent: string | null = 'claude') => ({ id, name: id, activity, status, agent })
  test('an agent working then quiet without ringing, shell still open: finished', () => {
    expect(newlyFinished([row('a', 'working')], [{ ...row('a', 'asked'), rang: false }]).map((s) => s.id)).toEqual(['a'])
    expect(newlyFinished([row('a', 'working')], [row('a', 'idle')]).map((s) => s.id)).toEqual(['a'])
  })
  test('an agent that rang is asking, not finished', () => {
    expect(newlyFinished([row('a', 'working')], [{ ...row('a', 'asked'), rang: true }])).toEqual([])
  })
  test('a plain shell going quiet is not "finished" (every command would notify)', () => {
    expect(newlyFinished([row('a', 'working', 'running', null)], [row('a', 'idle', 'running', null)])).toEqual([])
  })
  test('a closed shell is not; first sight is not; still working is not', () => {
    expect(newlyFinished([row('a', 'working')], [row('a', 'idle', 'idle')])).toEqual([])
    expect(newlyFinished([], [row('a', 'idle')])).toEqual([])
    expect(newlyFinished([row('a', 'working')], [row('a', 'working')])).toEqual([])
    expect(newlyFinished([row('a', 'idle')], [row('a', 'idle')])).toEqual([])
  })
})

describe('recentToOffer', () => {
  test('recent projects not already in the rail, newest first, once each, capped', () => {
    expect(recentToOffer(['/a', '/b', '/c', '/b'], ['/b'])).toEqual(['/a', '/c'])
    expect(recentToOffer([], ['/a'])).toEqual([])
    expect(recentToOffer(['/1', '/2', '/3'], [], 2)).toEqual(['/1', '/2'])
  })
})
