import { describe, expect, test } from 'bun:test'
import {
  attentionLabel,
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

  test('a session with no agent process is never "ready" — a green badge on a stopped session is a lie', () => {
    // Found in the running app: a session sitting at `idle` with a "ready" badge while
    // its own pane said "is not running". Landability is a claim about work to land;
    // with no agent there is no work in flight, so the badge must not carry it.
    for (const status of ['idle', 'dead', 'landed']) {
      expect(deriveAttention({ status, landability: 'ready' })).toBe('unknown')
      expect(deriveAttention({ status, landability: 'blocked' })).toBe('unknown')
    }
    // A running session is unaffected.
    expect(deriveAttention({ status: 'running', landability: 'ready' })).toBe('ready')
    expect(deriveAttention({ status: 'running', landability: 'blocked' })).toBe('conflict')
  })

  test('a blocked radar event still outranks "not running" — the block is the thing to act on', () => {
    expect(deriveAttention({ status: 'idle', landability: 'ready', recentBlocked: true })).toBe('blocked')
  })

  test('waiting still wins over landability, since the agent is alive and wants input', () => {
    expect(deriveAttention({ status: 'waiting', landability: 'ready' })).toBe('needs_you')
  })

  test('running with no extras is working', () => {
    expect(deriveAttention({ status: 'running' })).toBe('working')
  })

  test('idle with no extras is unknown, not working — nothing is running', () => {
    expect(deriveAttention({ status: 'idle' })).toBe('unknown')
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

describe('attentionLabel', () => {
  test('says "stopped" for a session with no agent, and "needs you" reads as two words', () => {
    expect(attentionLabel('unknown', 'idle')).toBe('stopped')
    expect(attentionLabel('unknown', 'dead')).toBe('dead')
    expect(attentionLabel('unknown', 'landed')).toBe('landed')
    // Still `unknown` when the gap is evidence, not a stopped process.
    expect(attentionLabel('unknown', 'running')).toBe('unknown')
    expect(attentionLabel('needs_you', 'waiting')).toBe('needs you')
    expect(attentionLabel('ready', 'running')).toBe('ready')
  })
})
