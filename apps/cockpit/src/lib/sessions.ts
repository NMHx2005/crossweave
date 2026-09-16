export type ListedSession = {
  id: string
  name: string
  status?: string
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
    out.push({ id: record.id, name, status })
  }
  return out
}
