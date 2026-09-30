import { describe, expect, test } from 'bun:test'
import { createLoadGate } from '../src/lib/load-gate'

describe('createLoadGate', () => {
  // Every tui.invalidate starts a load, and loads are not serialised: an older, slower one can finish AFTER a
  // newer one and put back a session list without the session the newer one had just shown.
  test('an older load that finishes after a newer one is dropped', () => {
    const gate = createLoadGate()
    const first = gate.start()
    const second = gate.start()
    expect(gate.accept(second)).toBe(true)
    expect(gate.accept(first)).toBe(false)
  })

  test('loads that finish in order all apply, and one still in flight does not block an older result', () => {
    const gate = createLoadGate()
    const a = gate.start()
    const b = gate.start()
    // b is still running: a's result is newer than anything applied so far, so it counts (no starvation).
    expect(gate.accept(a)).toBe(true)
    expect(gate.accept(b)).toBe(true)
  })

  test('a result is applied at most once', () => {
    const gate = createLoadGate()
    const a = gate.start()
    expect(gate.accept(a)).toBe(true)
    expect(gate.accept(a)).toBe(false)
  })

  test('a fresh gate accepts the first load', () => {
    const gate = createLoadGate()
    expect(gate.accept(gate.start())).toBe(true)
  })
})
