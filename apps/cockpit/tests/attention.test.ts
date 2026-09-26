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

  test('a stopped session keeps its landability, and the label says both facts', () => {
    // Was: stopped → always "unknown", because a bare green "ready" beside a pane
    // saying "is not running" read as a lie. But that also hid a CONFLICT on every
    // stopped session — and stopping is exactly how an agent's finished work waits to
    // land (kill keeps the worktree for that). The label now carries both facts.
    for (const status of ['idle', 'dead']) {
      expect(deriveAttention({ status, landability: 'ready' })).toBe('ready')
      expect(deriveAttention({ status, landability: 'blocked' })).toBe('conflict')
      expect(deriveAttention({ status, landability: 'unknown' })).toBe('unknown')
    }
    expect(attentionLabel('conflict', 'idle')).toBe('stopped · conflict')
    expect(attentionLabel('ready', 'idle')).toBe('stopped · ready to land')
    expect(attentionLabel('conflict', 'dead')).toBe('dead · conflict')
    // Landed work has nothing left to land or collide.
    expect(deriveAttention({ status: 'landed', landability: 'blocked' })).toBe('unknown')
    // A running session is unaffected.
    expect(deriveAttention({ status: 'running', landability: 'ready' })).toBe('ready')
    expect(attentionLabel('ready', 'running')).toBe('ready')
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
