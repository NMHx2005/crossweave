import { describe, expect, test } from 'bun:test'
import { attentionLabel, deriveAttention, parseLandabilityByName } from '../src/lib/attention'

describe('deriveAttention', () => {
  test('a running session is working, or carries its land verdict', () => {
    expect(deriveAttention({ status: 'running' })).toBe('working')
    expect(deriveAttention({ status: 'running', landability: 'ready' })).toBe('ready')
    expect(deriveAttention({ status: 'running', landability: 'blocked' })).toBe('conflict')
    expect(deriveAttention({ status: 'running', landability: 'unknown' })).toBe('unknown')
  })

  // Stopping is how finished work waits to land; a conflict there must still show.
  test('a stopped session keeps its landability, and the label says both facts', () => {
    for (const status of ['idle', 'dead']) {
      expect(deriveAttention({ status, landability: 'ready' })).toBe('ready')
      expect(deriveAttention({ status, landability: 'blocked' })).toBe('conflict')
      expect(deriveAttention({ status })).toBe('unknown')
    }
    expect(attentionLabel('conflict', 'idle')).toBe('stopped · conflict')
    expect(attentionLabel('ready', 'idle')).toBe('stopped · ready to land')
    expect(attentionLabel('conflict', 'dead')).toBe('dead · conflict')
    // Landed work has nothing left to land or collide.
    expect(deriveAttention({ status: 'landed', landability: 'blocked' })).toBe('unknown')
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
  test('says "stopped" for a session whose shell is closed', () => {
    expect(attentionLabel('unknown', 'idle')).toBe('stopped')
    expect(attentionLabel('unknown', 'dead')).toBe('dead')
    expect(attentionLabel('unknown', 'landed')).toBe('landed')
    // Still `unknown` when the gap is evidence, not a stopped process.
    expect(attentionLabel('unknown', 'running')).toBe('unknown')
    expect(attentionLabel('ready', 'running')).toBe('ready')
  })
})

describe('attentionLabel for an open shell', () => {
  test('reads "running": crossweave knows the shell is open, not what an agent is doing', () => {
    expect(attentionLabel('working', 'running')).toBe('running')
  })
})
