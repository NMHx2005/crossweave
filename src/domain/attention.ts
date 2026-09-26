export type AttentionKind = 'working' | 'ready' | 'unknown' | 'conflict'
export type Landability = 'ready' | 'unknown' | 'blocked'
export type DeriveAttentionInput = { status: string; landability?: Landability }
const NOT_RUNNING = new Set(['idle', 'dead', 'landed'])
export function deriveAttention(input: DeriveAttentionInput): AttentionKind {
  // A stopped session keeps its landability: stopping is how finished work waits to
  // land, and hiding a conflict there hid the one signal worth acting on. The label
  // (attentionLabel) says "stopped · …", so a green badge never reads as "running".
  if (input.status === 'landed') return 'unknown'
  if (input.landability === 'blocked') return 'conflict'
  if (input.landability === 'ready') return 'ready'
  if (input.landability === 'unknown' || NOT_RUNNING.has(input.status)) return 'unknown'
  return 'working'
}
export function attentionLabel(kind: AttentionKind, status: string): string {
  if (NOT_RUNNING.has(status)) {
    const state = status === 'idle' ? 'stopped' : status
    if (kind === 'conflict') return `${state} · conflict`
    if (kind === 'ready') return `${state} · ready to land`
    if (kind === 'unknown') return state
  }
  // `working` meant an agent at work; a session is now a shell, and all crossweave
  // knows is that it is open.
  return kind === 'working' ? 'running' : kind
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
