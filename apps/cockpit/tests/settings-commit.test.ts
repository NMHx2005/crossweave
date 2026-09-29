import { describe, expect, test } from 'bun:test'
import { createCommitter, type CommitClock } from '../src/lib/settings-commit'

function fakeClock(): CommitClock & { advance(ms: number): void } {
  let now = 0
  let nextId = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    setTimer(fn, ms) {
      const id = nextId++
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimer(h) {
      timers.delete(h as number)
    },
    advance(ms) {
      const target = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        now = due[1].at
        due[1].fn()
      }
      now = target
    },
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function setup(save: (v: string) => Promise<string | null>) {
  const clock = fakeClock()
  const results: Array<{ value: string; problem: string | null }> = []
  const c = createCommitter<string>({ save, delayMs: 100, clock, onResult: (value, problem) => results.push({ value, problem }) })
  return { c, clock, results }
}

describe('createCommitter', () => {
  test('waits out the delay, then saves once with the latest value (rapid input coalesces)', async () => {
    const saved: string[] = []
    const { c, clock, results } = setup(async (v) => { saved.push(v); return null })
    c.schedule('a')
    clock.advance(50)
    c.schedule('ab')
    clock.advance(50)
    expect(saved).toEqual([]) // the second schedule restarted the wait
    clock.advance(60)
    await tick()
    expect(saved).toEqual(['ab'])
    expect(results).toEqual([{ value: 'ab', problem: null }])
  })

  test('a refusal is reported with the value it refused, and does not stop later saves', async () => {
    const { c, clock, results } = setup(async (v) => (v === 'bad' ? 'not allowed' : null))
    c.schedule('bad')
    clock.advance(100)
    await tick()
    c.schedule('good')
    clock.advance(100)
    await tick()
    expect(results).toEqual([{ value: 'bad', problem: 'not allowed' }, { value: 'good', problem: null }])
  })

  test('never runs two saves at once: a change during a save is saved after it, latest only', async () => {
    let release!: () => void
    let inflight = 0
    let maxInflight = 0
    const saved: string[] = []
    const { c, clock } = setup((v) => {
      inflight++
      maxInflight = Math.max(maxInflight, inflight)
      saved.push(v)
      return new Promise<string | null>((resolve) => {
        release = () => { inflight--; resolve(null) }
      })
    })
    c.schedule('one')
    clock.advance(100)
    await tick()
    c.schedule('two')
    clock.advance(100)
    c.schedule('three')
    clock.advance(100)
    expect(saved).toEqual(['one']) // 'two' and 'three' wait for the first to finish
    release()
    await tick()
    expect(saved).toEqual(['one', 'three'])
    release()
    await tick()
    expect(maxInflight).toBe(1)
  })

  test('flush saves a pending value at once, without waiting for the delay', async () => {
    const saved: string[] = []
    const { c } = setup(async (v) => { saved.push(v); return null })
    c.schedule('x')
    await c.flush()
    expect(saved).toEqual(['x'])
  })

  test('flush with nothing pending does nothing', async () => {
    const saved: string[] = []
    const { c } = setup(async (v) => { saved.push(v); return null })
    await c.flush()
    expect(saved).toEqual([])
  })

  test('cancel drops a pending value: nothing is saved later', async () => {
    const saved: string[] = []
    const { c, clock } = setup(async (v) => { saved.push(v); return null })
    c.schedule('x')
    c.cancel()
    clock.advance(500)
    await tick()
    expect(saved).toEqual([])
  })

  test('a save that throws is reported as a problem, not an unhandled rejection', async () => {
    const { c, clock, results } = setup(async () => { throw new Error('boom') })
    c.schedule('x')
    clock.advance(100)
    await tick()
    expect(results).toEqual([{ value: 'x', problem: 'boom' }])
  })
})
