import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { LandVerdict } from '../lib/land-actions'
import { patchSections, type SessionDiff } from '../lib/patch'
import { plainErrorMessage } from '../lib/cockpit-host'

type ChangesPaneProps = {
  sessionName: string
  verdict: LandVerdict
  /** Changes whenever the session list does, so the diff refetches after new work. */
  revision: number
  loadDiff: () => Promise<SessionDiff>
  onLand: () => void
  landBusy: boolean
  /**
   * The session works in the project folder itself: it has no branch, so there is
   * nothing to compare or land. Said plainly instead of the daemon's refusal.
   */
  shared?: boolean
}

const VERDICT_TEXT: Record<LandVerdict['kind'], string> = {
  ready: 'Ready to land',
  blocked: 'Blocked',
  unknown: 'Not verified yet',
  empty: 'Nothing to land yet',
  none: 'Not checked',
}

const STATUS_MARK = { added: 'A', modified: 'M', deleted: 'D' } as const

/**
 * The land decision's evidence in one place: the convergence verdict, who this session
 * conflicts with, and the diff that landing would bring in. The review pointed out
 * that the cockpit asked for a land while showing none of this.
 */
export function ChangesPane({ sessionName, verdict, revision, loadDiff, onLand, landBusy, shared = false }: ChangesPaneProps) {
  const [diff, setDiff] = useState<SessionDiff | null>(null)
  const [error, setError] = useState<string | null>(null)
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({})
  // The latest loader, read at fetch time: the parent passes a fresh closure on every
  // render, and depending on it would refetch the diff on every render.
  const loadRef = useRef(loadDiff)
  loadRef.current = loadDiff

  useEffect(() => {
    if (shared) return
    let cancelled = false
    loadRef.current()
      .then((d) => { if (!cancelled) { setDiff(d); setError(null) } })
      .catch((err: unknown) => {
        if (!cancelled) setError(plainErrorMessage(err))
      })
    return () => { cancelled = true }
  }, [revision, sessionName, shared])

  const sections = useMemo(() => (diff ? patchSections(diff.patch) : []), [diff])
  const totals = diff?.files.reduce((t, f) => ({ added: t.added + f.added, deleted: t.deleted + f.deleted }), { added: 0, deleted: 0 })
  const canLand = verdict.kind === 'ready' || verdict.kind === 'unknown'

  if (shared) {
    return (
      <div class="cockpit-changes">
        <header class="cockpit-changes__head">
          <span class="cockpit-changes__verdict is-none">Works in the project folder</span>
        </header>
        <p class="cockpit-muted cockpit-changes__note">
          {sessionName} has no branch of its own, so there is nothing here to compare or land: what it changes
          is simply the project folder's uncommitted work (<code>git status</code> in its shell). Sessions
          started with “Own worktree” get a branch, and this pane then shows exactly what landing them would
          merge into your branch.
        </p>
      </div>
    )
  }

  return (
    <div class="cockpit-changes">
      <header class="cockpit-changes__head">
        <div>
          <span class={`cockpit-changes__verdict is-${verdict.kind}`}>{VERDICT_TEXT[verdict.kind]}</span>
          {verdict.reason ? <span class="cockpit-muted"> · {verdict.reason}</span> : null}
          {verdict.conflictsWith.length > 0 ? (
            <span class="cockpit-muted"> · conflicts with {verdict.conflictsWith.join(', ')}</span>
          ) : null}
        </div>
        <button type="button" class="cockpit-btn cockpit-btn--sm cockpit-btn--primary cockpit-changes__land" disabled={!canLand || landBusy} onClick={onLand}
          title={canLand ? `Merge ${sessionName} into the base` : VERDICT_TEXT[verdict.kind]}>
          Land {sessionName}
        </button>
      </header>
      {error ? <p class="cockpit-error" role="alert">{error}</p> : null}
      {diff === null && error === null ? <p class="cockpit-muted cockpit-changes__note">Loading changes…</p> : null}
      {diff ? (
        <>
          <p class="cockpit-muted cockpit-changes__note">
            {diff.files.length === 0
              ? 'No committed changes yet.'
              : `${diff.files.length} file${diff.files.length === 1 ? '' : 's'} · +${totals?.added ?? 0} −${totals?.deleted ?? 0}`}
            {diff.uncommitted > 0
              ? ` · ${diff.uncommitted} uncommitted file${diff.uncommitted === 1 ? '' : 's'} in the worktree (landing takes commits only)`
              : ''}
          </p>
          {diff.files.length > 0 ? (
            <ul class="cockpit-changes__files">
              {diff.files.map((f) => (
                <li key={f.path}>
                  <button type="button" onClick={() => sectionRefs.current[f.path]?.scrollIntoView({ block: 'start' })}>
                    <span class={`cockpit-changes__mark is-${f.status}`}>{STATUS_MARK[f.status]}</span>
                    <span class="cockpit-changes__path">{f.path}</span>
                    <span class="cockpit-changes__count">+{f.added} −{f.deleted}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <div class="cockpit-changes__patch">
            {sections.map((section) => (
              <section key={section.path} ref={(el) => { sectionRefs.current[section.path] = el }}>
                <h3 class="cockpit-changes__file">{section.path}</h3>
                <pre>
                  {section.lines.map((line, i) => (
                    <div key={i} class={`cockpit-diff-line is-${line.kind}`}>{line.text}</div>
                  ))}
                </pre>
              </section>
            ))}
            {diff.truncated ? <p class="cockpit-muted cockpit-changes__note">The diff is longer than shown — see the rest with `git diff` in a shell.</p> : null}
          </div>
        </>
      ) : null}
    </div>
  )
}
