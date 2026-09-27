import { describe, expect, test } from 'bun:test'
import { lastSeen, qrPath, reachLabel, secondsLeft } from '../src/lib/remote'

describe('remote helpers', () => {
  test('draws each dark module once, offset by the quiet zone', () => {
    expect(qrPath([[true, false], [false, true]], 4)).toBe('M4 4h1v1h-1zM5 5h1v1h-1z')
    expect(qrPath([[false]])).toBe('')
  })

  test('counts a code down to zero', () => {
    expect(secondsLeft(10_000, 0)).toBe(10)
    expect(secondsLeft(10_000, 9_001)).toBe(1)
    expect(secondsLeft(10_000, 20_000)).toBe(0)
  })

  test('names reaches and last-seen times in words', () => {
    expect(reachLabel('wifi')).toBe('Same Wi-Fi')
    const now = Date.parse('2026-09-27T12:00:00Z')
    expect(lastSeen(null, now)).toBe('never')
    expect(lastSeen('2026-09-27T11:59:30Z', now)).toBe('just now')
    expect(lastSeen('2026-09-27T11:55:00Z', now)).toBe('5 min ago')
    expect(lastSeen('2026-09-27T09:00:00Z', now)).toBe('3 h ago')
    expect(lastSeen('2026-09-20T09:00:00Z', now)).toBe('2026-09-20')
  })
})
