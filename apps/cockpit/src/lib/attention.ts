export type AttentionKind = 'working' | 'needs_you' | 'blocked' | 'ready' | 'unknown' | 'conflict'

export type Landability = 'ready' | 'unknown' | 'blocked'

export type DeriveAttentionInput = {
  status: string
  landability?: Landability
  recentBlocked?: boolean
}

/** Statuses where no agent process exists: there is nothing to be landable *from*. */
const NOT_RUNNING = new Set(['idle', 'dead', 'landed'])

/**
 * Badge priority: blocked > needs_you > landability conflict/ready/unknown > working.
 *
 * `recentBlocked` is a radar / Safe Mode `tui.event` of kind `blocked`.
 * `status === 'waiting'` is the session-status needs-you signal.
 * Converge landability `blocked` surfaces as the rail `conflict` badge.
 *
 * A session with no agent process never reads `ready` or `conflict`: both are claims
 * about work that could be landed, and there is no work in flight to land. It showed a
 * green "ready" badge on a stopped session until this was fixed, which reads as
 * "healthy" — the badge's job is to be honest about what needs a human, and a session
 * that needs *starting* is exactly that. `working` is deliberately not used for these
 * either: the badge should not say a session is doing something when it is not.
 */
export function deriveAttention(input: DeriveAttentionInput): AttentionKind {
  if (input.recentBlocked) return 'blocked'
  if (input.status === 'waiting') return 'needs_you'
  if (NOT_RUNNING.has(input.status)) return 'unknown'
  if (input.landability === 'blocked') return 'conflict'
  if (input.landability === 'ready') return 'ready'
  if (input.landability === 'unknown') return 'unknown'
  return 'working'
}

/**
 * The word a badge shows. Usually the attention kind itself, with one exception: an
 * `unknown` that comes from the session having no agent reads better as the plain fact
 * ("stopped") than as "unknown", which sounds like a data problem rather than a state
 * the user can act on. `unknown` from landability is left alone — that one really is
 * "we have no evidence yet".
 */
export function attentionLabel(kind: AttentionKind, status: string): string {
  if (kind === 'unknown' && NOT_RUNNING.has(status)) return status === 'idle' ? 'stopped' : status
  return kind === 'needs_you' ? 'needs you' : kind
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
