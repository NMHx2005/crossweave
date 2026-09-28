/** A row from `session.history`: a session that was landed or removed, after its own row is gone. */
export type SessionHistoryEntry = {
  name: string
  agentKind: string
  branch: string | null
  finalStatus: 'landed' | 'dead'
  createdAt: string
  endedAt: string
  tokenSpent: number
  costSpentUsd: number
  note: string | null
}

/** `{ history: [...] }` from the daemon, or anything malformed → []. */
export function parseSessionHistory(value: unknown): SessionHistoryEntry[] {
  const list = (value as { history?: unknown } | null)?.history
  if (!Array.isArray(list)) return []
  const out: SessionHistoryEntry[] = []
  for (const item of list) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const r = item as Record<string, unknown>
    if (typeof r.name !== 'string' || r.name.length === 0) continue
    if (r.finalStatus !== 'landed' && r.finalStatus !== 'dead') continue
    if (typeof r.endedAt !== 'string') continue
    out.push({
      name: r.name,
      agentKind: typeof r.agentKind === 'string' ? r.agentKind : 'shell',
      branch: typeof r.branch === 'string' ? r.branch : null,
      finalStatus: r.finalStatus,
      createdAt: typeof r.createdAt === 'string' ? r.createdAt : r.endedAt,
      endedAt: r.endedAt,
      tokenSpent: typeof r.tokenSpent === 'number' ? r.tokenSpent : 0,
      costSpentUsd: typeof r.costSpentUsd === 'number' ? r.costSpentUsd : 0,
      note: typeof r.note === 'string' ? r.note : null,
    })
  }
  return out
}
