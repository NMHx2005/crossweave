import { describe, expect, test } from 'bun:test'
import { planFlip, playFlip, structureKey, type Animatable, type Box } from '../src/lib/flip'
import type { LayoutNode } from '../src/lib/layout'

const box = (left: number, top: number, width: number, height: number): Box => ({ left, top, width, height })
const map = (entries: Array<[string, Box]>): Map<string, Box> => new Map(entries)

describe('planFlip', () => {
  test('a pane that only moved animates with the inverse translate (old minus new)', () => {
    const steps = planFlip(map([['a', box(0, 0, 100, 50)]]), map([['a', box(100, 20, 100, 50)]]))
    expect(steps).toEqual([{ id: 'a', kind: 'move', dx: -100, dy: -20 }])
  })

  test('nothing changed: nothing to animate', () => {
    const rects = map([['a', box(0, 0, 100, 50)], ['b', box(100, 0, 100, 50)]])
    expect(planFlip(rects, new Map(rects))).toEqual([])
  })

  test('a sub-pixel difference is not an animation', () => {
    expect(planFlip(map([['a', box(0, 0, 100, 50)]]), map([['a', box(0.4, 0.3, 100.2, 50)]]))).toEqual([])
  })

  test('a pane whose SIZE changed fades: it is never scaled, since the terminal has already refitted', () => {
    const steps = planFlip(map([['a', box(0, 0, 200, 50)]]), map([['a', box(0, 0, 100, 50)]]))
    expect(steps).toEqual([{ id: 'a', kind: 'fade' }])
  })

  test('a new pane fades in; a pane that is gone needs nothing', () => {
    const steps = planFlip(map([['a', box(0, 0, 100, 50)], ['gone', box(0, 60, 100, 50)]]), map([['a', box(0, 0, 100, 50)], ['b', box(100, 0, 100, 50)]]))
    expect(steps).toEqual([{ id: 'b', kind: 'fade' }])
  })

  test('the first layout has nothing to animate from', () => {
    expect(planFlip(new Map(), map([['a', box(0, 0, 100, 50)]]), 1, false)).toEqual([])
  })
})

type Call = { keyframes: Keyframe[]; options: KeyframeAnimationOptions }
function recorder(): Animatable & { calls: Call[] } {
  const calls: Call[] = []
  return { calls, animate: (keyframes, options) => { calls.push({ keyframes: keyframes as Keyframe[], options }); return undefined } }
}

describe('playFlip', () => {
  const opts = { durationMs: 180, easing: 'ease-out' }

  test('a move animates transform from the inverse delta to identity, translate only', () => {
    const a = recorder()
    const n = playFlip(new Map([['a', a]]), [{ id: 'a', kind: 'move', dx: -100, dy: -20 }], { ...opts, reduced: false })
    expect(n).toBe(1)
    expect(a.calls[0]!.keyframes).toEqual([{ transform: 'translate(-100px, -20px)' }, { transform: 'translate(0, 0)' }])
    expect(a.calls[0]!.options).toMatchObject({ duration: 180, easing: 'ease-out' })
    expect(JSON.stringify(a.calls[0]!.keyframes)).not.toContain('scale')
  })

  test('a fade animates opacity only', () => {
    const a = recorder()
    playFlip(new Map([['a', a]]), [{ id: 'a', kind: 'fade' }], { ...opts, reduced: false })
    expect(Object.keys(a.calls[0]!.keyframes[0]!)).toEqual(['opacity'])
  })

  // WAAPI is not covered by the CSS prefers-reduced-motion rule, so the helper must obey it.
  test('under prefers-reduced-motion it starts nothing at all', () => {
    const a = recorder()
    const n = playFlip(new Map([['a', a]]), [{ id: 'a', kind: 'move', dx: 5, dy: 5 }, { id: 'a', kind: 'fade' }], { ...opts, reduced: true })
    expect(n).toBe(0)
    expect(a.calls).toEqual([])
  })

  test('a step for an element that is not mounted is skipped', () => {
    expect(playFlip(new Map(), [{ id: 'x', kind: 'fade' }], { ...opts, reduced: false })).toBe(0)
  })
})

describe('structureKey', () => {
  const pane = (id: string): LayoutNode => ({ type: 'pane', id, pane: { kind: 'session', sessionId: id } })
  const split = (id: string, dir: 'row' | 'column', sizes: number[], children: LayoutNode[]): LayoutNode => ({ type: 'split', id, dir, sizes, children })

  test('ignores split sizes: dragging a divider is not a structural change', () => {
    const a = split('s', 'row', [1, 1], [pane('a'), pane('b')])
    const b = split('s', 'row', [3, 1], [pane('a'), pane('b')])
    expect(structureKey(a)).toBe(structureKey(b))
  })

  test('changes when a pane is added, removed, moved or the direction flips', () => {
    const base = structureKey(split('s', 'row', [1, 1], [pane('a'), pane('b')]))
    expect(structureKey(split('s', 'row', [1, 1, 1], [pane('a'), pane('b'), pane('c')]))).not.toBe(base)
    expect(structureKey(pane('a'))).not.toBe(base)
    expect(structureKey(split('s', 'row', [1, 1], [pane('b'), pane('a')]))).not.toBe(base)
    expect(structureKey(split('s', 'column', [1, 1], [pane('a'), pane('b')]))).not.toBe(base)
  })
})
