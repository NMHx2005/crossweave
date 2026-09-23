import { describe, it, expect } from 'bun:test'
import { deriveAttention, attentionLabel, parseLandabilityByName, nextBlockedNames, blockedSessionFromEvent } from '../../src/domain/attention.js'
describe('deriveAttention (engine)', () => {
  it('waiting -> needs_you even when landable', () => { expect(deriveAttention({ status: 'waiting', landability: 'ready' })).toBe('needs_you') })
  it('recentBlocked -> blocked', () => { expect(deriveAttention({ status: 'running', recentBlocked: true })).toBe('blocked') })
  it('idle/dead/landed -> unknown (stopped)', () => { expect(deriveAttention({ status: 'idle' })).toBe('unknown'); expect(attentionLabel('unknown','idle')).toBe('stopped') })
  it('landability ready/blocked/unknown map correctly', () => {
    expect(deriveAttention({ status: 'running', landability: 'ready' })).toBe('ready')
    expect(deriveAttention({ status: 'running', landability: 'blocked' })).toBe('conflict')
    expect(deriveAttention({ status: 'running', landability: 'unknown' })).toBe('unknown')
  })
  it('running with no extras -> working', () => { expect(deriveAttention({ status: 'running' })).toBe('working') })
})
describe('parseLandabilityByName', () => {
  it('maps ready/unknown/blocked', () => {
    const m = parseLandabilityByName({ ready: ['a'], unknown: [{name:'b'}], blocked: [{name:'c'}] })
    expect(m.get('a')).toBe('ready'); expect(m.get('b')).toBe('unknown'); expect(m.get('c')).toBe('blocked')
  })
})
describe('nextBlockedNames / blockedSessionFromEvent', () => {
  it('blocked event adds name', () => { expect(nextBlockedNames(new Set(), { type:'blocked', name:'x' }).has('x')).toBe(true) })
  it('blockedSessionFromEvent reads session', () => { expect(blockedSessionFromEvent({ kind:'blocked', session:'s1' })).toBe('s1') })
})
