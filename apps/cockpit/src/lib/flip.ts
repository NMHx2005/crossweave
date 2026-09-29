import type { LayoutNode } from './layout'

/** A pane wrapper's box in viewport pixels. */
export interface Box {
  left: number
  top: number
  width: number
  height: number
}

export type FlipStep =
  | { id: string; kind: 'move'; dx: number; dy: number }
  | { id: string; kind: 'fade' }

/**
 * What to animate between two layouts (FLIP: First, Last, Invert, Play).
 *
 * Only POSITION is animated, and only as a translate. A pane whose size changed just
 * fades: its terminal has already refitted to the new grid, and a scale would stretch
 * the text for the whole animation. A new pane fades in; a removed one needs nothing.
 * `hadPrevious` is false for the very first layout, where there is nothing to animate from.
 */
export function planFlip(prev: ReadonlyMap<string, Box>, next: ReadonlyMap<string, Box>, epsilon = 1, hadPrevious = prev.size > 0): FlipStep[] {
  if (!hadPrevious) return []
  const steps: FlipStep[] = []
  for (const [id, now] of next) {
    const before = prev.get(id)
    if (before === undefined) {
      steps.push({ id, kind: 'fade' })
      continue
    }
    if (Math.abs(before.width - now.width) > epsilon || Math.abs(before.height - now.height) > epsilon) {
      steps.push({ id, kind: 'fade' })
      continue
    }
    const dx = before.left - now.left
    const dy = before.top - now.top
    if (Math.abs(dx) > epsilon || Math.abs(dy) > epsilon) steps.push({ id, kind: 'move', dx, dy })
  }
  return steps
}

/** The part of an Element that `playFlip` needs, so the timing logic tests without a DOM. */
export interface Animatable {
  animate(keyframes: Keyframe[], options: KeyframeAnimationOptions): unknown
}

/**
 * The OS asked for less motion. `element.animate()` ignores the CSS
 * `prefers-reduced-motion` rule, so anything driven from script must ask itself.
 */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

export interface PlayOptions {
  durationMs: number
  easing: string
  /** Injected for tests; defaults to the OS setting. */
  reduced?: boolean
}

/** Start the planned animations. Returns how many started (0 under reduced motion). */
export function playFlip(els: ReadonlyMap<string, Animatable>, steps: readonly FlipStep[], opts: PlayOptions): number {
  if (opts.reduced ?? prefersReducedMotion()) return 0
  let started = 0
  for (const step of steps) {
    const el = els.get(step.id)
    if (el === undefined) continue
    const options: KeyframeAnimationOptions = { duration: opts.durationMs, easing: opts.easing }
    if (step.kind === 'move') {
      el.animate([{ transform: `translate(${step.dx}px, ${step.dy}px)` }, { transform: 'translate(0, 0)' }], options)
    } else {
      el.animate([{ opacity: 0.4 }, { opacity: 1 }], options)
    }
    started++
  }
  return started
}

/**
 * The shape of a layout without its sizes, so a divider drag or a window resize is not
 * mistaken for a split, close or swap: only those should animate.
 */
export function structureKey(node: LayoutNode): string {
  if (node.type === 'pane') return node.id
  return `${node.dir === 'row' ? 'r' : 'c'}(${node.children.map(structureKey).join(',')})`
}
