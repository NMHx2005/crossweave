import { describe, expect, test } from 'bun:test'
import { agentName, gitBadge, landChip, newlyAsking, overlapBadge, railOrder, relativeTime, rowState, glyphState, ROW_STATE_LABEL, rowTitle, visibleRows, jumpTargets, clampMenu, newlyFinished, newlySignalled, checkChip, landCheckWarning, recentToOffer, submenuPosition, sessionStatusDetail } from '../src/lib/rail'
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

describe('sessionStatusDetail', () => {
  const now = 10_000_000_000

  test('uses an explicit notification timestamp and identifies its source', () => {
    expect(sessionStatusDetail({ signal: { kind: 'done', message: 'finished', at: now - 120_000 } }, now))
      .toBe('Status reported by cw notify · updated 2m ago')
  })

  test('labels inferred status and omits an unavailable timestamp', () => {
    expect(sessionStatusDetail({ lastActivityAt: null }, now)).toBe('Status inferred from terminal activity')
  })

  test('describes a current event without saying "now ago"', () => {
    expect(sessionStatusDetail({ lastActivityAt: now }, now)).toBe('Status inferred from terminal activity · last activity just now')
  })

  test('dates an inferred status by the terminal activity, not as if it had been reported', () => {
    expect(sessionStatusDetail({ lastActivityAt: now - 3 * 3_600_000 }, now))
      .toBe('Status inferred from terminal activity · last activity 3h ago')
  })

  test('a clock-skewed (future) timestamp reads as just now rather than a negative age', () => {
    expect(sessionStatusDetail({ signal: { kind: 'ask', message: 'q', at: now + 5_000 } }, now))
      .toBe('Status reported by cw notify · updated just now')
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
  // Spinning while the agent works, green when it finished its turn, amber only when it
  // asks you something (a permission prompt, a question: it rang, or its prompt is up).
  test('done and asking are told apart by whether it asked', () => {
    expect(rowState({ status: 'running', activity: 'asked', rang: false })).toBe('done')
    expect(rowState({ status: 'running', activity: 'asked', rang: true })).toBe('asked')
    expect(rowState({ status: 'running', activity: 'asked' })).toBe('done')
  })

  test('every state has words that say what it means', () => {
    for (const state of ['working', 'done', 'asked', 'failed', 'idle', 'stopped', 'ended'] as const) {
      expect(ROW_STATE_LABEL[state].length).toBeGreaterThan(8)
    }
  })

  test('an open shell shows its activity; a closed one says why', () => {
    expect(rowState({ status: 'running', activity: 'working' })).toBe('working')
    expect(rowState({ status: 'running', activity: 'asked', rang: true })).toBe('asked')
    expect(rowState({ status: 'running' })).toBe('idle')
    expect(rowState({ status: 'idle' })).toBe('stopped')
    expect(rowState({ status: 'idle', activity: 'failed' })).toBe('failed')
    expect(rowState({ status: 'landed' })).toBe('ended')
  })
})

describe('glyphState', () => {
  // The user's rule: nothing for a quiet shell; a loading mark while the agent works; a mark that
  // says "finished, check it" that goes away once looked at. The ✓ is that mark, so no circle for it.
  test('a finished turn and a quiet shell draw no circle; everything else keeps its own', () => {
    expect(glyphState('done')).toBe('idle')
    expect(glyphState('idle')).toBe('idle')
    for (const state of ['working', 'asked', 'failed', 'stopped', 'ended'] as const) expect(glyphState(state)).toBe(state)
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

describe('overlapBadge', () => {
  test('names the other session(s), with the shared paths in the title', () => {
    expect(overlapBadge([{ session: 'bob', paths: ['a.ts', 'b.ts'] }]))
      .toEqual({ label: '⇄ bob', title: 'bob: a.ts, b.ts' })
  })
  test('collapses extra sessions into a count', () => {
    expect(overlapBadge([
      { session: 'bob', paths: ['a.ts'] },
      { session: 'carol', paths: ['b.ts'] },
      { session: 'dave', paths: ['c.ts'] },
    ])).toEqual({ label: '⇄ bob +2', title: 'bob: a.ts · carol: b.ts · dave: c.ts' })
  })
  test('nothing when there is no overlap', () => {
    expect(overlapBadge(undefined)).toBeUndefined()
    expect(overlapBadge([])).toBeUndefined()
  })
})

describe('parseSessionList overlaps', () => {
  test('keeps well-formed overlaps and drops malformed ones', () => {
    expect(parseSessionList([{ id: 'a', name: 'a', overlaps: [{ session: 'bob', paths: ['x.ts'] }] }])[0]?.overlaps)
      .toEqual([{ session: 'bob', paths: ['x.ts'] }])
    expect(parseSessionList([{ id: 'a', name: 'a', overlaps: [{ paths: ['x.ts'] }] }])[0]?.overlaps).toBeUndefined()
    expect(parseSessionList([{ id: 'a', name: 'a', overlaps: 'nope' }])[0]?.overlaps).toBeUndefined()
    expect(parseSessionList([{ id: 'a', name: 'a' }])[0]?.overlaps).toBeUndefined()
  })
})

describe('parseSessionList setup', () => {
  test('keeps a recognized setup status, drops anything else', () => {
    expect(parseSessionList([{ id: 'a', name: 'a', setup: 'pending' }])[0]?.setup).toBe('pending')
    expect(parseSessionList([{ id: 'a', name: 'a', setup: 'failed' }])[0]?.setup).toBe('failed')
    expect(parseSessionList([{ id: 'a', name: 'a', setup: 'bogus' }])[0]?.setup).toBeUndefined()
    expect(parseSessionList([{ id: 'a', name: 'a' }])[0]?.setup).toBeUndefined()
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

describe('submenuPosition', () => {
  const view = { width: 1000, height: 800 }
  test('opens to the right of its item, tops level', () => {
    expect(submenuPosition({ left: 40, right: 240, top: 600 }, { width: 200, height: 100 }, view)).toEqual({ left: 244, top: 596 })
  })
  test('flips left when the right side has no room', () => {
    expect(submenuPosition({ left: 700, right: 900, top: 100 }, { width: 200, height: 100 }, view)).toEqual({ left: 496, top: 96 })
  })
  test('is pulled up to stay on screen, never above the margin', () => {
    expect(submenuPosition({ left: 40, right: 240, top: 780 }, { width: 200, height: 300 }, view).top).toBe(492)
    expect(submenuPosition({ left: 40, right: 240, top: 10 }, { width: 200, height: 2000 }, view).top).toBe(8)
  })
})

describe('newlySignalled', () => {
  const session = (id: string, signal?: { kind: 'done' | 'ask'; message: string; at: number }) => ({ id, name: id, ...(signal ? { signal } : {}) })

  test('a done signal that was not there before is news, even with no agent and no earlier "working"', () => {
    expect(newlySignalled([session('a')], [session('a', { kind: 'done', message: 'x', at: 5 })]).map((s) => s.id)).toEqual(['a'])
  })

  test('the same signal seen again is not news; a later one is', () => {
    const sig = { kind: 'done' as const, message: 'x', at: 5 }
    expect(newlySignalled([session('a', sig)], [session('a', sig)])).toEqual([])
    expect(newlySignalled([session('a', sig)], [session('a', { ...sig, at: 9 })]).map((s) => s.id)).toEqual(['a'])
  })

  test('a first sight (a reload) is not news, and an ask is the amber path, not this one', () => {
    expect(newlySignalled([], [session('a', { kind: 'done', message: '', at: 1 })])).toEqual([])
    expect(newlySignalled([session('a')], [session('a', { kind: 'ask', message: 'which?', at: 1 })])).toEqual([])
  })
})

describe('parseSessionList carries the signal', () => {
  test('a well-formed signal is kept; anything else is dropped', () => {
    const [ok, badKind, badAt, none] = parseSessionList([
      { id: 'a', name: 'a', signal: { kind: 'done', message: 'x', at: 3 } },
      { id: 'b', name: 'b', signal: { kind: 'run', message: 'x', at: 3 } },
      { id: 'c', name: 'c', signal: { kind: 'done', message: 'x', at: 'later' } },
      { id: 'd', name: 'd' },
    ])
    expect(ok?.signal).toEqual({ kind: 'done', message: 'x', at: 3 })
    expect(badKind?.signal).toBeUndefined()
    expect(badAt?.signal).toBeUndefined()
    expect(none?.signal).toBeUndefined()
  })
})

describe('checkChip', () => {
  test('nothing until a check was run', () => {
    expect(checkChip(undefined)).toBeUndefined()
  })

  test('running says so; a verdict has words as well as a colour', () => {
    expect(checkChip({ state: 'running', at: 1, stale: false })).toMatchObject({ label: 'tests…', tone: 'running' })
    expect(checkChip({ state: 'pass', at: 1, ms: 4200, stale: false })).toMatchObject({ label: '✓ tests', tone: 'pass', stale: false, title: 'Tests passed in 4.2s' })
    expect(checkChip({ state: 'fail', at: 1, ms: 1000, code: 2, stale: false })).toMatchObject({ label: '✗ tests', tone: 'fail', title: 'Tests failed (exit 2) in 1.0s' })
  })

  test('a verdict the work has moved past is stale and says to run it again, never passing as current', () => {
    const chip = checkChip({ state: 'pass', at: 1, ms: 1000, stale: true })
    expect(chip?.stale).toBe(true)
    expect(chip?.title).toContain('run the checks again')
  })
})

describe('parseSessionList carries the check verdict', () => {
  test('a well-formed verdict is kept; a malformed one is dropped', () => {
    const [ok, bad] = parseSessionList([
      { id: 'a', name: 'a', check: { state: 'fail', at: 5, ms: 10, code: 1, tail: 'boom', stale: true } },
      { id: 'b', name: 'b', check: { state: 'maybe', at: 5 } },
    ])
    expect(ok?.check).toEqual({ state: 'fail', at: 5, ms: 10, code: 1, tail: 'boom', stale: true })
    expect(bad?.check).toBeUndefined()
  })
})

describe('landCheckWarning', () => {
  test('failing tests that still describe the work ask first, naming the session and the exit code', () => {
    const w = landCheckWarning('alpha', { state: 'fail', at: 1, code: 2, stale: false })
    expect(w?.title).toContain('alpha')
    expect(w?.body).toContain('exit 2')
    expect(w?.confirmLabel).toBe('Land anyway')
  })

  test('a run that has not finished asks too', () => {
    expect(landCheckWarning('alpha', { state: 'running', at: 1, stale: false })?.title).toContain('while its tests run')
  })

  test('nothing to say for a pass, a session never checked, or a verdict the work has moved past', () => {
    expect(landCheckWarning('a', { state: 'pass', at: 1, stale: false })).toBeUndefined()
    expect(landCheckWarning('a', undefined)).toBeUndefined()
    expect(landCheckWarning('a', { state: 'fail', at: 1, code: 1, stale: true })).toBeUndefined()
    expect(landCheckWarning('a', { state: 'running', at: 1, stale: true })).toBeUndefined()
  })
})

describe('rowTitle with a notify message', () => {
  test('what the session said itself beats the log, but the user\'s own note beats both', () => {
    const signal = { kind: 'done' as const, message: 'tests written', at: 1 }
    expect(rowTitle({ name: 'a', latestWords: 'Tracing…', signal })).toBe('tests written')
    expect(rowTitle({ name: 'a', latestWords: 'Tracing…', note: 'fix login', signal })).toBe('fix login')
    expect(rowTitle({ name: 'a', latestWords: 'Tracing…', signal: { kind: 'done', message: '', at: 1 } })).toBe('Tracing…')
  })
})
