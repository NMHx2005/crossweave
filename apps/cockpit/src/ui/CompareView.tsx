import { useEffect, useMemo, useState } from 'preact/hooks'
import type { LandVerdict } from '../lib/land-actions'
import { compareSessions, type CompareRow, type CompareSide, type PairMerge } from '../lib/compare'
import { checkChip } from '../lib/rail'
import { patchSections, type SessionDiff } from '../lib/patch'
import { plainErrorMessage } from '../lib/cockpit-host'
import type { ListedSession } from '../lib/sessions'

type CompareViewProps = {
  /** Sessions with a branch of their own: the only ones with something to compare or land. */
  sessions: readonly ListedSession[]
  leftId: string
  rightId: string
  /** Changes whenever the session list does, so diffs refetch after new work. */
  revision: number
  loadDiff: (id: string) => Promise<SessionDiff>
  verdictOf: (id: string) => LandVerdict
  /** What the background trial merge says about these two landing together. */
  pairMergeOf: (leftId: string, rightId: string) => PairMerge
  onLand: (id: string) => void
  landBusy: boolean
  onClose: () => void
}

const STATUS_MARK = { added: 'A', modified: 'M', deleted: 'D' } as const
const VERDICT_TEXT: Record<LandVerdict['kind'], string> = {
  ready: 'Ready to land', blocked: 'Blocked', unknown: 'Not verified yet', empty: 'Nothing to land yet', none: 'Not checked',
}

type Loaded = { diff: SessionDiff } | { error: string } | undefined

/**
 * Two sessions' work side by side, to choose which attempt to land: each one's files, the ones both touched
 * marked (that is where they will meet), whether both made the very same change there, its tests verdict and
 * the verdict for landing. A modal, not a pane: it lives for one decision.
 */
export function CompareView({ sessions, leftId, rightId, revision, loadDiff, verdictOf, pairMergeOf, onLand, landBusy, onClose }: CompareViewProps) {
  const [ids, setIds] = useState<[string, string]>([leftId, rightId])
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({})
  const [open, setOpen] = useState<{ side: 0 | 1; path: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    for (const id of new Set(ids)) {
      loadDiff(id).then(
        (diff) => { if (!cancelled) setLoaded((l) => ({ ...l, [id]: { diff } })) },
        (err: unknown) => { if (!cancelled) setLoaded((l) => ({ ...l, [id]: { error: plainErrorMessage(err) } })) },
      )
    }
    return () => { cancelled = true }
    // loadDiff is a fresh closure on every render; the ids and the revision are what decide a refetch.
  }, [ids[0], ids[1], revision])

  const byId = (id: string): ListedSession | undefined => sessions.find((s) => s.id === id)
  const left = loaded[ids[0]]
  const right = loaded[ids[1]]
  const comparison = useMemo(() => {
    const a = byId(ids[0])
    const b = byId(ids[1])
    return left && 'diff' in left && right && 'diff' in right && a && b
      ? compareSessions({ name: a.name, diff: left.diff }, { name: b.name, diff: right.diff })
      : undefined
  }, [left, right, ids[0], ids[1]])

  const column = (side: 0 | 1, data: CompareSide | undefined, state: Loaded) => {
    const id = ids[side]
    const session = byId(id)
    const verdict = verdictOf(id)
    const tests = checkChip(session?.check)
    const canLand = verdict.kind === 'ready' || verdict.kind === 'unknown'
    const section = open?.side === side && state && 'diff' in state ? patchSections(state.diff.patch).find((s) => s.path === open.path) : undefined
    return (
      <section class="cockpit-compare__side" aria-label={session?.name ?? 'session'}>
        <header class="cockpit-compare__head">
          <select value={id} aria-label={side === 0 ? 'Left session' : 'Right session'}
            onChange={(e) => { const next = (e.target as HTMLSelectElement).value; setOpen(null); setIds((cur) => (side === 0 ? [next, cur[1]] : [cur[0], next])) }}>
            {sessions.map((s) => <option key={s.id} value={s.id} disabled={s.id === ids[1 - side]}>{s.name}</option>)}
          </select>
          <span class={`cockpit-changes__verdict is-${verdict.kind}`}>{VERDICT_TEXT[verdict.kind]}</span>
          {tests ? <span class={`cockpit-testchip cockpit-testchip--${tests.tone}${tests.stale ? ' is-stale' : ''}`} title={tests.title}>{tests.label}</span> : null}
          <button type="button" class="cockpit-btn cockpit-btn--sm cockpit-btn--primary" disabled={!canLand || landBusy}
            title={canLand ? `Merge ${session?.name ?? ''} into the base` : VERDICT_TEXT[verdict.kind]} onClick={() => onLand(id)}>
            Land this one
          </button>
        </header>
        {state && 'error' in state ? <p class="cockpit-error" role="alert">{state.error}</p> : null}
        {state === undefined ? <p class="cockpit-muted">Loading changes…</p> : null}
        {data ? (
          <>
            <p class="cockpit-muted cockpit-compare__totals">
              {data.totals.files === 0 ? 'No committed changes yet.' : `${data.totals.files} file${data.totals.files === 1 ? '' : 's'} · +${data.totals.added} −${data.totals.deleted}`}
              {data.uncommitted > 0 ? ` · ${data.uncommitted} uncommitted (landing takes commits only)` : ''}
              {data.truncated ? ' · diff cut at the size limit' : ''}
            </p>
            <ul class="cockpit-changes__files">
              {data.files.map((f: CompareRow) => (
                <li key={f.path}>
                  <button type="button" class={f.both ? 'is-both' : ''} aria-expanded={open?.side === side && open.path === f.path}
                    onClick={() => setOpen(open?.side === side && open.path === f.path ? null : { side, path: f.path })}>
                    <span class={`cockpit-changes__mark is-${f.status}`}>{STATUS_MARK[f.status]}</span>
                    <span class="cockpit-changes__path">{f.path}</span>
                    {f.both ? <span class="cockpit-compare__both" title={f.same ? 'Both sessions made exactly this change' : 'Both sessions changed this file: they will meet here'}>{f.same ? 'both · same' : 'both'}</span> : null}
                    <span class="cockpit-changes__count">+{f.added} −{f.deleted}</span>
                  </button>
                </li>
              ))}
            </ul>
            {section ? (
              <pre class="cockpit-compare__patch" aria-label={`Changes to ${section.path}`}>
                {section.lines.map((line, i) => <div key={i} class={`cockpit-diff-line is-${line.kind}`}>{line.text}</div>)}
              </pre>
            ) : null}
          </>
        ) : null}
      </section>
    )
  }

  return (
    <div class="cockpit-picker__backdrop" onClick={onClose}>
      <div class="cockpit-picker cockpit-compare" role="dialog" aria-label="Compare sessions" onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }}>
        <div class="cockpit-compare__title">
          <h2 class="cockpit-picker__title">Compare sessions</h2>
          <span class="cockpit-muted">
            {comparison ? (comparison.shared.length === 0 ? 'They touch different files.' : `${comparison.shared.length} file${comparison.shared.length === 1 ? '' : 's'} touched by both`) : ''}
          </span>
          {(() => {
            const merge = pairMergeOf(ids[0], ids[1])
            return (
              <span class={`cockpit-changes__verdict is-${merge === 'conflict' ? 'blocked' : merge === 'clean' ? 'ready' : 'unknown'}`}
                title="The background trial merge of these two branches">
                {merge === 'conflict' ? 'Landing both conflicts' : merge === 'clean' ? 'Merge together: clean' : 'Merge together: not tried'}
              </span>
            )
          })()}
          <button type="button" class="cockpit-btn cockpit-btn--sm" onClick={onClose}>Close</button>
        </div>
        <div class="cockpit-compare__cols">
          {column(0, comparison?.a, left)}
          {column(1, comparison?.b, right)}
        </div>
      </div>
    </div>
  )
}
