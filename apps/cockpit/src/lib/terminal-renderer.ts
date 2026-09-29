/** The part of xterm's WebGL addon the coordinator needs, so it tests without a GPU. */
export interface GlAddon {
  dispose(): void
  onContextLoss(cb: () => void): { dispose(): void }
}

export interface AcquireOptions<A> {
  /** Its tab and project are on screen and the container has a size. */
  visible: boolean
  /** Attach the addon to the terminal (`term.loadAddon`). A throw counts as no GPU. */
  load(addon: A): void
  /**
   * The GPU renderer went away (evicted, or the context was lost). xterm falls back to
   * its DOM renderer, which draws from the terminal's own buffer; the pane should
   * refresh its whole viewport so nothing stays blank until the next output.
   */
  onFallback(): void
}

interface Held<A> {
  addon: A
  visible: boolean
  used: number
  onFallback: () => void
  lossSub: { dispose(): void }
}

/**
 * Which panes hold a WebGL context. Chromium caps live contexts (about 16) and the
 * cockpit keeps every tab of up to six projects mounted, so panes must not each take
 * one. Hidden panes KEEP theirs — dropping it would rebuild the glyph atlas on every
 * tab switch — and the budget, not visibility, is what forces one out; then hidden
 * before visible, least recently used first. Anything without a context is on the DOM
 * renderer, which is slower but complete.
 */
export class RendererCoordinator<A extends GlAddon> {
  private readonly held = new Map<string, Held<A>>()
  private clock = 0

  /** `create` returns undefined when WebGL2 is unavailable. */
  constructor(
    private readonly create: () => A | undefined,
    private readonly budget = 12,
  ) {}

  get size(): number {
    return this.held.size
  }

  active(key: string): boolean {
    return this.held.has(key)
  }

  acquire(key: string, opts: AcquireOptions<A>): boolean {
    const existing = this.held.get(key)
    if (existing !== undefined) {
      existing.visible = opts.visible
      existing.used = ++this.clock
      existing.onFallback = opts.onFallback
      return true
    }
    if (this.held.size >= this.budget) {
      const victim = this.victim()
      // A hidden pane may not push out one somebody is looking at.
      if (victim === undefined || (victim[1].visible && !opts.visible)) return false
      this.drop(victim[0])
    }
    let addon: A | undefined
    try {
      addon = this.create()
      if (addon === undefined) return false
      opts.load(addon)
    } catch {
      addon?.dispose()
      return false
    }
    const held: Held<A> = {
      addon, visible: opts.visible, used: ++this.clock, onFallback: opts.onFallback,
      lossSub: addon.onContextLoss(() => this.drop(key)),
    }
    this.held.set(key, held)
    return true
  }

  setVisible(key: string, visible: boolean): void {
    const h = this.held.get(key)
    if (h === undefined) return
    h.visible = visible
    if (visible) h.used = ++this.clock
  }

  /** The pane is going away: free the slot without a fallback (the terminal is disposed). */
  release(key: string): void {
    const h = this.held.get(key)
    if (h === undefined) return
    this.held.delete(key)
    h.lossSub.dispose()
    h.addon.dispose()
  }

  private victim(): [string, Held<A>] | undefined {
    let best: [string, Held<A>] | undefined
    for (const entry of this.held) {
      const [, h] = entry
      const [, b] = best ?? entry
      if (best === undefined || Number(h.visible) < Number(b.visible) || (h.visible === b.visible && h.used < b.used)) best = entry
    }
    return best
  }

  /** Dispose and tell the pane to repaint on the DOM renderer. */
  private drop(key: string): void {
    const h = this.held.get(key)
    if (h === undefined) return
    this.held.delete(key)
    h.lossSub.dispose()
    h.addon.dispose()
    h.onFallback()
  }
}
