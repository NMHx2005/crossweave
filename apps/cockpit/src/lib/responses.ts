import type { ListedSession } from './sessions'
import { checkChip, ROW_STATE_LABEL, rowState, type RowState } from './rail'

/** A row of the Responses view: a session the last prompt went to, and what it says now. */
export interface ResponseRow {
  id: string
  name: string
  state: RowState
  stateLabel: string
  lastActivityAt: number | null
  latestWords?: string
  check?: { label: string; tone: 'running' | 'pass' | 'fail'; stale: boolean; title: string }
}

/**
 * The sessions the composer last sent to (their ids, in send order), as rows — a
 * session that has since vanished drops out, and a repeated id counts once. In-memory
 * by design: the view is worth one working stretch, not a restart. The state, words
 * and checks chip are the rail's own (`rail.ts`), so the two never disagree.
 */
export function responseRows(ids: readonly string[], byId: ReadonlyMap<string, ListedSession>): ResponseRow[] {
  const out: ResponseRow[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    const s = byId.get(id)
    if (s === undefined) continue
    const state = rowState(s)
    const chip = s.check === undefined ? undefined : checkChip(s.check)
    out.push({
      id: s.id,
      name: s.name,
      state,
      stateLabel: ROW_STATE_LABEL[state],
      lastActivityAt: s.lastActivityAt ?? null,
      ...(s.latestWords !== undefined ? { latestWords: s.latestWords } : {}),
      ...(chip !== undefined ? { check: chip } : {}),
    })
  }
  return out
}
