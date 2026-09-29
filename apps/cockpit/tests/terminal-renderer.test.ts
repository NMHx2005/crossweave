import { describe, expect, test } from 'bun:test'
import { RendererCoordinator, type GlAddon } from '../src/lib/terminal-renderer'

class FakeAddon implements GlAddon {
  disposed = 0
  private lost: (() => void) | undefined
  dispose(): void { this.disposed++ }
  onContextLoss(cb: () => void): { dispose(): void } {
    this.lost = cb
    return { dispose: () => { this.lost = undefined } }
  }
  loseContext(): void { this.lost?.() }
}

function setup(budget = 3, opts: { supported?: boolean } = {}) {
  const made: FakeAddon[] = []
  const c = new RendererCoordinator<FakeAddon>(() => {
    if (opts.supported === false) return undefined
    const a = new FakeAddon()
    made.push(a)
    return a
  }, budget)
  const fallbacks: string[] = []
  const acquire = (key: string, visible: boolean) =>
    c.acquire(key, { visible, load: () => undefined, onFallback: () => fallbacks.push(key) })
  return { c, made, fallbacks, acquire }
}

describe('RendererCoordinator', () => {
  test('a pane that acquires gets a GPU renderer, and acquiring again is idempotent', () => {
    const { c, made, acquire } = setup()
    expect(acquire('a', true)).toBe(true)
    expect(acquire('a', true)).toBe(true)
    expect(made.length).toBe(1)
    expect(c.active('a')).toBe(true)
  })

  test('the budget is respected: never more live contexts than the budget', () => {
    const { c, acquire } = setup(3)
    for (const k of ['a', 'b', 'c', 'd', 'e']) acquire(k, true)
    expect(c.size).toBe(3)
  })

  test('hidden panes keep their context until the budget is reached', () => {
    const { c, acquire } = setup(3)
    acquire('a', true)
    acquire('b', true)
    c.setVisible('a', false)
    c.setVisible('b', false)
    expect(c.active('a') && c.active('b')).toBe(true)
  })

  test('over budget, the least recently used HIDDEN pane is evicted before any visible one', () => {
    const { c, made, fallbacks, acquire } = setup(3)
    acquire('old-visible', true)
    acquire('hidden-1', true)
    acquire('hidden-2', true)
    c.setVisible('hidden-1', false)
    c.setVisible('hidden-2', false)
    acquire('new', true)
    expect(c.active('old-visible')).toBe(true)
    expect(c.active('hidden-1')).toBe(false) // hidden and least recently used
    expect(c.active('hidden-2')).toBe(true)
    expect(made[1]!.disposed).toBe(1)
    expect(fallbacks).toEqual(['hidden-1'])
  })

  test('a pane evicted while visible is told to fall back, so it can repaint from its own buffer', () => {
    const { c, fallbacks, acquire } = setup(2)
    acquire('a', true)
    acquire('b', true)
    acquire('c', true) // everything visible: the oldest goes
    expect(c.active('a')).toBe(false)
    expect(fallbacks).toEqual(['a'])
  })

  test('a hidden pane never evicts a visible one: it just stays on the DOM renderer', () => {
    const { c, fallbacks, acquire } = setup(2)
    acquire('a', true)
    acquire('b', true)
    expect(acquire('hidden', false)).toBe(false)
    expect(c.active('a') && c.active('b')).toBe(true)
    expect(fallbacks).toEqual([])
  })

  test('release disposes the addon and frees its slot', () => {
    const { c, made, acquire } = setup(1)
    acquire('a', true)
    c.release('a')
    expect(made[0]!.disposed).toBe(1)
    expect(acquire('b', true)).toBe(true)
    c.release('missing') // releasing what was never held is harmless
  })

  test('context loss disposes at once, frees the slot, and the pane falls back to the DOM', () => {
    const { c, made, fallbacks, acquire } = setup(1)
    acquire('a', true)
    made[0]!.loseContext()
    expect(made[0]!.disposed).toBe(1)
    expect(c.active('a')).toBe(false)
    expect(fallbacks).toEqual(['a'])
    expect(acquire('a', true)).toBe(true) // may re-acquire once the context is back
  })

  test('no WebGL2: stays on the DOM renderer and never throws', () => {
    const { c, acquire } = setup(3, { supported: false })
    expect(acquire('a', true)).toBe(false)
    expect(c.size).toBe(0)
  })

  test('an addon that throws while loading is disposed and not counted', () => {
    const { c, made } = setup(3)
    const ok = c.acquire('a', { visible: true, load: () => { throw new Error('no gl') }, onFallback: () => undefined })
    expect(ok).toBe(false)
    expect(made[0]!.disposed).toBe(1)
    expect(c.size).toBe(0)
  })
})
