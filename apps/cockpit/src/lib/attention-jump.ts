import type { AttentionKind } from './attention'

/** Most urgent first: a conflict to resolve, then work ready to land. */
const URGENCY: Partial<Record<AttentionKind, number>> = { conflict: 0, ready: 1 }

/**
 * The session ⌘⇧A jumps to: the most urgent one, and on a repeat press the next of
 * the same urgency after the one already focused, so each is one key away. Null when
 * nothing needs you.
 */
export function nextAttentionSession(
  order: ReadonlyArray<{ id: string }>,
  attentionById: Readonly<Record<string, AttentionKind | undefined>>,
  focusedId: string | null,
): string | null {
  let best = Number.POSITIVE_INFINITY
  for (const s of order) {
    const u = URGENCY[attentionById[s.id] ?? 'unknown']
    if (u !== undefined && u < best) best = u
  }
  if (best === Number.POSITIVE_INFINITY) return null
  const candidates = order.filter((s) => URGENCY[attentionById[s.id] ?? 'unknown'] === best)
  const at = candidates.findIndex((s) => s.id === focusedId)
  return candidates[(at + 1) % candidates.length]!.id
}
