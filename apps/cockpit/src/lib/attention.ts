export type AttentionKind = 'working' | 'needs_you' | 'blocked' | 'ready' | 'unknown' | 'conflict'

export type Landability = 'ready' | 'unknown' | 'blocked'

export type DeriveAttentionInput = {
  status: string
  landability?: Landability
  recentBlocked?: boolean
}

/**
 * Badge priority: blocked > needs_you > landability conflict/ready/unknown > working.
 *
 * `recentBlocked` is a radar / Safe Mode `tui.event` of kind `blocked`.
 * `status === 'waiting'` is the session-status needs-you signal.
 * Converge landability `blocked` surfaces as the rail `conflict` badge.
 */
export function deriveAttention(input: DeriveAttentionInput): AttentionKind {
  if (input.recentBlocked) return 'blocked'
  if (input.status === 'waiting') return 'needs_you'
  if (input.landability === 'blocked') return 'conflict'
  if (input.landability === 'ready') return 'ready'
  if (input.landability === 'unknown') return 'unknown'
  return 'working'
}

export function blockedSessionFromEvent(payload: unknown): string | null {
  const record = asRecord(payload)
  if (record.kind !== 'blocked') return null
  return typeof record.session === 'string' && record.session.length > 0 ? record.session : null
}

export type BlockedNamesAction = { type: 'clear' } | { type: 'blocked'; name: string }

/** Sticky radar blocked names. Clear on load/invalidate so they cannot permanently override landability. */
export function nextBlockedNames(
  current: ReadonlySet<string>,
  action: BlockedNamesAction,
): ReadonlySet<string> {
  if (action.type === 'clear') return new Set()
  if (current.has(action.name)) return current
  const next = new Set(current)
  next.add(action.name)
  return next
}

export function parseLandabilityByName(value: unknown): Map<string, Landability> {
  const map = new Map<string, Landability>()
  const record = asRecord(value)
  for (const name of stringList(record.ready)) map.set(name, 'ready')
  for (const name of namedList(record.unknown)) map.set(name, 'unknown')
  for (const name of namedList(record.blocked)) map.set(name, 'blocked')
  return map
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

function namedList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const names: string[] = []
  for (const item of value) {
    const record = asRecord(item)
    if (typeof record.name === 'string' && record.name.length > 0) names.push(record.name)
  }
  return names
}
