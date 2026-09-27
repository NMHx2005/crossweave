/**
 * Which projects keep a live view (tabs, splits, terminals) in the window: the most
 * recently shown, up to `cap`, always including the one on the stage and only ever
 * projects still open. A project that falls out keeps running in its daemon; showing
 * it again re-attaches its panes, as a switch used to every time.
 *
 * `recent` is most recent first; the result keeps that order.
 */
export function mountedViews(recent: readonly string[], active: string | null, open: readonly string[], cap: number): string[] {
  const isOpen = new Set(open)
  const out: string[] = []
  for (const root of active === null ? recent : [active, ...recent]) {
    if (out.length >= Math.max(1, cap)) break
    if (!isOpen.has(root) || out.includes(root)) continue
    out.push(root)
  }
  return out
}

/** `recent` with `root` moved to the front. */
export function touchRecent(recent: readonly string[], root: string): string[] {
  return [root, ...recent.filter((r) => r !== root)]
}
