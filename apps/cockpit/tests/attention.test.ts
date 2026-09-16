import { describe, expect, test } from 'bun:test'
import {
  blockedSessionFromEvent,
  deriveAttention,
  nextBlockedNames,
  parseLandabilityByName,
} from '../src/lib/attention'

describe('deriveAttention', () => {
  test('recentBlocked is blocked even when waiting and ready to land', () => {
    expect(
      deriveAttention({ status: 'waiting', landability: 'ready', recentBlocked: true }),
    ).toBe('blocked')
  })

  test('waiting needs you even when landability is ready', () => {
    expect(deriveAttention({ status: 'waiting', landability: 'ready' })).toBe('needs_you')
  })

  test('waiting needs you even when landability is conflict-blocked', () => {
    expect(deriveAttention({ status: 'waiting', landability: 'blocked' })).toBe('needs_you')
  })

  test('landability blocked is conflict', () => {
    expect(deriveAttention({ status: 'running', landability: 'blocked' })).toBe('conflict')
  })

  test('landability ready is ready', () => {
    expect(deriveAttention({ status: 'running', landability: 'ready' })).toBe('ready')
  })

  test('landability unknown is unknown', () => {
    expect(deriveAttention({ status: 'idle', landability: 'unknown' })).toBe('unknown')
  })

  test('running with no extras is working', () => {
    expect(deriveAttention({ status: 'running' })).toBe('working')
  })

  test('idle with no extras is working', () => {
    expect(deriveAttention({ status: 'idle' })).toBe('working')
  })

  test('recentBlocked beats landability blocked', () => {
    expect(
      deriveAttention({ status: 'running', landability: 'blocked', recentBlocked: true }),
    ).toBe('blocked')
  })

  test('recentBlocked false does not elevate', () => {
    expect(deriveAttention({ status: 'running', recentBlocked: false })).toBe('working')
  })
})

describe('blockedSessionFromEvent', () => {
  test('reads the session name from a blocked tui.event', () => {
    expect(
      blockedSessionFromEvent({
        kind: 'blocked',
        session: 'auth',
        path: 'src/x.ts',
        symbol: 'foo',
      }),
    ).toBe('auth')
  })

  test('ignores non-blocked events and junk', () => {
    expect(blockedSessionFromEvent({ kind: 'land', session: 'auth', ok: true })).toBeNull()
    expect(blockedSessionFromEvent({ kind: 'blocked' })).toBeNull()
    expect(blockedSessionFromEvent(null)).toBeNull()
    expect(blockedSessionFromEvent('blocked')).toBeNull()
  })
})

describe('nextBlockedNames', () => {
  test('blocked event adds a name without dropping others', () => {
    const first = nextBlockedNames(new Set(), { type: 'blocked', name: 'auth' })
    const second = nextBlockedNames(first, { type: 'blocked', name: 'billing' })
    expect([...second].sort()).toEqual(['auth', 'billing'])
  })

  test('clear on load/invalidate drops sticky names so landability is not permanently overridden', () => {
    const sticky = nextBlockedNames(new Set(['auth']), { type: 'blocked', name: 'billing' })
    expect(nextBlockedNames(sticky, { type: 'clear' }).size).toBe(0)
    expect(
      deriveAttention({
        status: 'running',
        landability: 'ready',
        recentBlocked: nextBlockedNames(sticky, { type: 'clear' }).has('auth'),
      }),
    ).toBe('ready')
  })

  test('duplicate blocked name does not allocate a new set', () => {
    const current = new Set(['auth'])
    expect(nextBlockedNames(current, { type: 'blocked', name: 'auth' })).toBe(current)
  })
})

describe('parseLandabilityByName', () => {
  test('maps ready / unknown / blocked names from converge.status', () => {
    const map = parseLandabilityByName({
      ready: ['alpha'],
      unknown: [{ name: 'beta', reason: 'unverified' }],
      blocked: [{ name: 'gamma', reason: 'conflict' }],
    })
    expect(map.get('alpha')).toBe('ready')
    expect(map.get('beta')).toBe('unknown')
    expect(map.get('gamma')).toBe('blocked')
    expect(map.get('missing')).toBeUndefined()
  })

  test('empty or non-object is empty', () => {
    expect(parseLandabilityByName(undefined).size).toBe(0)
    expect(parseLandabilityByName([]).size).toBe(0)
  })
})
