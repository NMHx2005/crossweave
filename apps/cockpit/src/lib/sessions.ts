export type ListedSession = {
  id: string
  name: string
  status?: string
  agentKind?: string
  enforcementTier?: string
  costSpentUsd?: number
  tokenSpent?: number
}

export function parseSessionList(value: unknown): ListedSession[] {
  if (!Array.isArray(value)) return []
  const out: ListedSession[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    if (typeof record.id !== 'string' || record.id.length === 0) continue
    const name = typeof record.name === 'string' && record.name.length > 0 ? record.name : record.id
    const status = typeof record.status === 'string' ? record.status : undefined
    const agentKind = typeof record.agentKind === 'string' ? record.agentKind : undefined
    const enforcementTier =
      typeof record.enforcementTier === 'string' ? record.enforcementTier : undefined
    const costSpentUsd = typeof record.costSpentUsd === 'number' ? record.costSpentUsd : undefined
    const tokenSpent = typeof record.tokenSpent === 'number' ? record.tokenSpent : undefined
    const row: ListedSession = { id: record.id, name, status }
    if (agentKind) row.agentKind = agentKind
    if (enforcementTier) row.enforcementTier = enforcementTier
    if (costSpentUsd !== undefined) row.costSpentUsd = costSpentUsd
    if (tokenSpent !== undefined) row.tokenSpent = tokenSpent
    out.push(row)
  }
  return out
}

export function formatRailMeta(session: ListedSession): string | undefined {
  const parts: string[] = []
  if (session.enforcementTier) parts.push(session.enforcementTier)
  if (typeof session.costSpentUsd === 'number') parts.push(`$${session.costSpentUsd.toFixed(2)}`)
  return parts.length > 0 ? parts.join(' · ') : undefined
}
