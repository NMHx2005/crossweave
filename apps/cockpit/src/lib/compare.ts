import { patchSections, type SessionDiff } from './patch'

export type CompareRow = { path: string; status: 'added' | 'modified' | 'deleted'; added: number; deleted: number; both: boolean; same: boolean }
export type CompareSide = {
  name: string
  files: CompareRow[]
  totals: { files: number; added: number; deleted: number }
  uncommitted: number
  truncated: boolean
}
export type Comparison = { a: CompareSide; b: CompareSide; shared: string[] }

/** One file's changed lines, as text, to tell whether two sessions made the very same change. */
function sectionText(patch: string): Map<string, string> {
  return new Map(patchSections(patch).map((s) => [s.path, s.lines.filter((l) => l.kind === 'add' || l.kind === 'del').map((l) => l.text).join('\n')]))
}

/**
 * Two sessions' changes side by side. `shared` are the files both touched — where they will meet when both land;
 * a row is `same` when both made exactly the same change there (then the second land is a no-op, not a conflict).
 * A patch cut at the size limit proves nothing about equality, so it never yields `same`.
 */
export function compareSessions(a: { name: string; diff: SessionDiff }, b: { name: string; diff: SessionDiff }): Comparison {
  const inA = new Set(a.diff.files.map((f) => f.path))
  const inB = new Set(b.diff.files.map((f) => f.path))
  const shared = [...inA].filter((p) => inB.has(p)).sort()
  const bothSet = new Set(shared)
  const textA = sectionText(a.diff.patch)
  const textB = sectionText(b.diff.patch)
  const provable = !a.diff.truncated && !b.diff.truncated
  const side = (self: typeof a): CompareSide => ({
    name: self.name,
    files: self.diff.files
      .map((f): CompareRow => ({
        ...f,
        both: bothSet.has(f.path),
        same: provable && bothSet.has(f.path) && textA.has(f.path) && textA.get(f.path) === textB.get(f.path),
      }))
      .sort((x, y) => Number(y.both) - Number(x.both) || x.path.localeCompare(y.path)),
    totals: self.diff.files.reduce((t, f) => ({ files: t.files + 1, added: t.added + f.added, deleted: t.deleted + f.deleted }), { files: 0, added: 0, deleted: 0 }),
    uncommitted: self.diff.uncommitted,
    truncated: self.diff.truncated,
  })
  return { a: side(a), b: side(b), shared }
}

export type PairMerge = 'conflict' | 'clean' | 'unknown'

/**
 * What the background trial merge says about landing these two together. Only `conflict` and `clean` are
 * statements about the merge; a missing pair (never tried, or too many sessions to try them all) and a trial
 * that only failed the tests or could not be verified say nothing, so they are `unknown` rather than `clean`.
 * Overlap in `shared` is not a conflict: two sessions can edit one file in different places.
 */
export function pairMerge(
  branchA: string | null,
  branchB: string | null,
  pairwise: ReadonlyArray<{ a: string; b: string; result: string }>,
): PairMerge {
  if (branchA === null || branchB === null) return 'unknown'
  const trial = pairwise.find((p) => (p.a === branchA && p.b === branchB) || (p.a === branchB && p.b === branchA))
  return trial?.result === 'conflict' || trial?.result === 'clean' ? trial.result : 'unknown'
}

/** Who to put opposite `current` at first: the session it overlaps most with, else the first other one. */
export function defaultCompareTarget(
  current: { id: string; overlaps?: ReadonlyArray<{ session: string; paths: readonly string[] }> },
  sessions: ReadonlyArray<{ id: string; name: string }>,
): string | undefined {
  const others = sessions.filter((s) => s.id !== current.id)
  const ranked = [...(current.overlaps ?? [])].sort((x, y) => y.paths.length - x.paths.length)
  for (const o of ranked) {
    const hit = others.find((s) => s.name === o.session || s.id === o.session)
    if (hit !== undefined) return hit.id
  }
  return others[0]?.id
}
