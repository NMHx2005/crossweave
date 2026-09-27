import { describe, expect, test } from 'bun:test'
import { agentName, landChip, newlyAsking, railOrder, relativeTime, rowState, rowTitle } from '../src/lib/rail'
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
  test('what the agent last said, else the session name', () => {
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
  test('only a session seen turning to asked, not one already asking or first seen', () => {
    const prev = [{ id: 'a', activity: 'working' }, { id: 'b', activity: 'asked' }]
    const next = [
      { id: 'a', name: 'a', activity: 'asked' },
      { id: 'b', name: 'b', activity: 'asked' },
      { id: 'c', name: 'c', activity: 'asked' },
    ]
    expect(newlyAsking(prev, next).map((s) => s.id)).toEqual(['a'])
  })
})
