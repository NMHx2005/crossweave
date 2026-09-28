import { describe, expect, test } from 'bun:test'
import { parseSessionHistory } from '../src/lib/session-history'

describe('parseSessionHistory', () => {
  test('parses a well-formed history response', () => {
    const out = parseSessionHistory({
      history: [
        {
          name: 'auth', agentKind: 'claude', branch: 'cw/auth', finalStatus: 'landed',
          createdAt: '2026-09-28T00:00:00.000Z', endedAt: '2026-09-28T01:00:00.000Z',
          tokenSpent: 100, costSpentUsd: 0.5, note: 'fixed the redirect',
        },
      ],
    })
    expect(out).toEqual([{
      name: 'auth', agentKind: 'claude', branch: 'cw/auth', finalStatus: 'landed',
      createdAt: '2026-09-28T00:00:00.000Z', endedAt: '2026-09-28T01:00:00.000Z',
      tokenSpent: 100, costSpentUsd: 0.5, note: 'fixed the redirect',
    }])
  })

  test('missing optional fields fall back to safe defaults', () => {
    const out = parseSessionHistory({
      history: [{ name: 'auth', finalStatus: 'dead', endedAt: '2026-09-28T01:00:00.000Z' }],
    })
    expect(out).toEqual([{
      name: 'auth', agentKind: 'shell', branch: null, finalStatus: 'dead',
      createdAt: '2026-09-28T01:00:00.000Z', endedAt: '2026-09-28T01:00:00.000Z',
      tokenSpent: 0, costSpentUsd: 0, note: null,
    }])
  })

  test('drops entries missing a name, a valid finalStatus, or endedAt', () => {
    const out = parseSessionHistory({
      history: [
        { finalStatus: 'dead', endedAt: '2026-09-28T01:00:00.000Z' },
        { name: 'x', finalStatus: 'archived', endedAt: '2026-09-28T01:00:00.000Z' },
        { name: 'y', finalStatus: 'dead' },
        { name: 'ok', finalStatus: 'dead', endedAt: '2026-09-28T01:00:00.000Z' },
      ],
    })
    expect(out.map((r) => r.name)).toEqual(['ok'])
  })

  test('non-array or missing history, and malformed entries, become []', () => {
    expect(parseSessionHistory(undefined)).toEqual([])
    expect(parseSessionHistory(null)).toEqual([])
    expect(parseSessionHistory({})).toEqual([])
    expect(parseSessionHistory({ history: 'nope' })).toEqual([])
    expect(parseSessionHistory({ history: [null, 'x', 42] })).toEqual([])
  })
})
