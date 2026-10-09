import type { SessionDiff } from './patch'

export type CheckpointKind = 'start' | 'turn' | 'manual' | 'pre-restore'
export type Checkpoint = {
  seq: number
  kind: CheckpointKind
  label?: string
  at: number
  head: string
  files: { added: number; modified: number; deleted: number }
}
export type RestorePlan = { write: string[]; delete: string[] }
/** `checkpoint.diff`'s answer: a `session.diff` without the uncommitted count (a checkpoint has no such notion). */
export type CheckpointDiff = Omit<SessionDiff, 'uncommitted'>

const KINDS: readonly string[] = ['start', 'turn', 'manual', 'pre-restore']
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** `{ checkpoints: [...] }` from the daemon, or anything malformed → []. */
export function parseCheckpoints(value: unknown): Checkpoint[] {
  const list = (value as { checkpoints?: unknown } | null)?.checkpoints
  if (!Array.isArray(list)) return []
  const out: Checkpoint[] = []
  for (const item of list) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const r = item as Record<string, unknown>
    if (typeof r.seq !== 'number' || !Number.isInteger(r.seq) || r.seq < 1) continue
    if (typeof r.kind !== 'string' || !KINDS.includes(r.kind)) continue
    const files = (r.files ?? {}) as Record<string, unknown>
    out.push({
      seq: r.seq,
      kind: r.kind as CheckpointKind,
      ...(typeof r.label === 'string' && r.label !== '' ? { label: r.label } : {}),
      at: count(r.at),
      head: typeof r.head === 'string' ? r.head : '',
      files: { added: count(files.added), modified: count(files.modified), deleted: count(files.deleted) },
    })
  }
  return out
}

const strings = (v: unknown): string[] => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : [])

/** The plan out of a `checkpoint.restore` reply (a preview or an applied one); malformed → nothing to do. */
export function parseRestorePlan(value: unknown): RestorePlan {
  const plan = (value as { plan?: { write?: unknown; delete?: unknown } } | null | undefined)?.plan
  return { write: strings(plan?.write), delete: strings(plan?.delete) }
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** The confirmation's words: what changes, that the way back is saved first, and a warning while an agent works. */
export function describeRestore(seq: number, plan: RestorePlan, working: boolean): { title: string; body: string } {
  const title = `Restore checkpoint #${seq}?`
  const paths = [...plan.write, ...plan.delete]
  if (paths.length === 0) return { title, body: 'Nothing to change: the worktree already matches this checkpoint.' }
  const shown = paths.slice(0, 8).join(', ')
  const rest = paths.length > 8 ? ` and ${paths.length - 8} more` : ''
  const lines = [
    `Write ${plural(plan.write.length, 'file')}, delete ${plural(plan.delete.length, 'file')}.`,
    `${shown}${rest}`,
    'A return point is saved first.',
  ]
  if (working) lines.push('This session looks busy: an agent working in these files may fight the restore.')
  return { title, body: lines.join(' ') }
}
