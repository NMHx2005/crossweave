import type { AttentionKind } from './attention'

/** Most urgent first. `working` and `unknown` never ask for you. */
const URGENCY: Partial<Record<AttentionKind, number>> = { needs_you: 0, blocked: 1, conflict: 2, ready: 3 }

/**
 * The session ⌘⇧A jumps to: the most urgent one, and on a repeat press the next of
 * the same urgency after the one already focused, so every waiting agent is one key
 * away. Null when nothing needs you.
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
