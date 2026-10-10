/** @jsxImportSource preact */
import { Fragment } from 'preact'
import { useMemo, useReducer, useState } from 'preact/hooks'
import { patchSections, type PatchSection } from '../lib/patch'
import type { SendTarget } from '../lib/prompt-send'
import {
  anchorOf, deliverReview, emptyReview, lineKey, matchComments, reviewReducer, MAX_COMMENT_CHARS,
  type Anchor, type ReviewComment,
} from '../lib/review-comments'

const sameAnchor = (a: Anchor | null, b: Anchor | null): boolean => a !== null && b !== null && lineKey(a) === lineKey(b) && a.quote === b.quote

// A stable function: Preact calls a ref again whenever its identity changes, and an inline one would pull focus back into
// the textarea on every render (the diff re-renders on each poll).
const focusOnMount = (el: HTMLTextAreaElement | null): void => { el?.focus() }

/**
 * Hook-free so it is walk-tested. The draft lives in the DOM (an uncontrolled textarea) and is read on submit; a form with
 * no `action` would navigate the Electron window, so the submit is always prevented, and Escape must not reach the
 * Checkpoints dialog, which closes on it.
 */
export function CommentEditor({ initial, submitLabel, onSubmit, onCancel }: {
  initial?: string
  submitLabel: string
  onSubmit: (text: string) => void
  onCancel: () => void
}) {
  return (
    <form class="cockpit-diff-editor"
      onSubmit={(ev) => {
        ev.preventDefault()
        onSubmit(String(new FormData(ev.currentTarget as HTMLFormElement).get('comment') ?? ''))
      }}
      onKeyDown={(ev) => { if (ev.code === 'Escape') { ev.stopPropagation(); onCancel() } }}>
      <textarea name="comment" class="cockpit-diff-editor__text" rows={3} maxLength={MAX_COMMENT_CHARS} aria-label="Comment" ref={focusOnMount}>{initial ?? ''}</textarea>
      <span class="cockpit-diff-editor__actions">
        <button type="submit" class="cockpit-btn cockpit-btn--sm cockpit-btn--primary">{submitLabel}</button>
        <button type="button" class="cockpit-btn cockpit-btn--sm" onClick={onCancel}>Cancel</button>
      </span>
    </form>
  )
}

export type DiffLinesProps = {
  sections: readonly PatchSection[]
  byLine: ReadonlyMap<string, readonly ReviewComment[]>
  /** The line a new comment is being written for. Compared by anchor, so a reload that moves lines cannot re-point it. */
  composing: Anchor | null
  editing: number | null
  onCompose: (anchor: Anchor) => void
  onAdd: (anchor: Anchor, text: string) => void
  onCancel: () => void
  onEdit: (id: number) => void
  onSave: (id: number, text: string) => void
  onDelete: (id: number) => void
  sectionRef?: (path: string, el: HTMLElement | null) => void
}

/** The diff itself: a `+` in the gutter of every line that can carry a comment, and the comments under their lines. */
export function DiffLines(p: DiffLinesProps) {
  return (
    <>
      {p.sections.map((section, si) => (
        <section key={`${si}:${section.path}`} ref={p.sectionRef === undefined ? undefined : (el) => p.sectionRef?.(section.path, el)}>
          <h3 class="cockpit-changes__file">{section.path}</h3>
          <pre>
            {section.lines.map((line, i) => {
              const anchor = anchorOf(section.path, line)
              const key = anchor === null ? String(i) : lineKey(anchor)
              const here = anchor === null ? [] : (p.byLine.get(key) ?? [])
              return (
                <Fragment key={`${i}:${key}`}>
                  <div class="cockpit-diff-row">
                    {anchor === null
                      ? <span class="cockpit-diff-gutter" />
                      : <button type="button" class="cockpit-diff-add" aria-label={`Comment on ${section.path} line ${anchor.line}${anchor.side === 'old' ? ' (removed)' : ''}`}
                          onClick={() => p.onCompose(anchor)}>+</button>}
                    <div class={`cockpit-diff-line is-${line.kind}`}>{line.text}</div>
                  </div>
                  {here.map((c) => (
                    <div key={`c${c.id}`} class="cockpit-diff-comment">
                      {p.editing === c.id
                        ? <CommentEditor initial={c.text} submitLabel="Save" onSubmit={(text) => p.onSave(c.id, text)} onCancel={p.onCancel} />
                        : (
                          <>
                            <div class="cockpit-diff-comment__text">{c.text}</div>
                            <span class="cockpit-diff-comment__actions">
                              <button type="button" class="cockpit-btn cockpit-btn--sm" onClick={() => p.onEdit(c.id)}>Edit</button>
                              <button type="button" class="cockpit-btn cockpit-btn--sm" onClick={() => p.onDelete(c.id)}>Delete</button>
                            </span>
                          </>
                        )}
                    </div>
                  ))}
                  {anchor !== null && sameAnchor(p.composing, anchor) ? (
                    <div key={`compose:${key}`} class="cockpit-diff-comment">
                      <CommentEditor submitLabel="Add" onSubmit={(text) => p.onAdd(anchor, text)} onCancel={p.onCancel} />
                    </div>
                  ) : null}
                </Fragment>
              )
            })}
          </pre>
        </section>
      ))}
    </>
  )
}

/** Count, Send and Clear, plus the comments whose line is no longer in the diff. Hidden when there is nothing to send. */
export function ReviewBar({ count, outdated, targetName, busy, onSend, onClear, onDeleteOutdated }: {
  count: number
  outdated: readonly ReviewComment[]
  targetName: string
  busy: boolean
  onSend: () => void
  onClear: () => void
  onDeleteOutdated: (id: number) => void
}) {
  if (count === 0) return null
  return (
    <div class="cockpit-review-bar">
      <div class="cockpit-review-bar__main">
        <span>{`${count} comment${count === 1 ? '' : 's'}`}</span>
        <button type="button" class="cockpit-btn cockpit-btn--sm cockpit-btn--primary" disabled={busy}
          title="Pastes them into the shell; nothing runs until you press Enter there" onClick={onSend}>{`Send to ${targetName}'s shell`}</button>
        <button type="button" class="cockpit-btn cockpit-btn--sm" disabled={busy} onClick={onClear}>Clear</button>
      </div>
      {outdated.length > 0 ? (
        <ul class="cockpit-review-bar__outdated" aria-label="Comments whose line changed">
          {outdated.map((c) => (
            <li key={c.id}>
              <span class="cockpit-muted">{`${c.path}:${c.line} (outdated)`}</span>
              <span>{c.text}</span>
              <button type="button" class="cockpit-btn cockpit-btn--sm" onClick={() => onDeleteOutdated(c.id)}>Delete</button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/**
 * A diff whose lines can be commented on, and a Send that pastes the comments into the session's shell — never pressing
 * Enter. State is local: it is gone when the pane or dialog closes, and a caller that shows another diff re-keys it.
 */
export function CommentableDiff({ patch, truncatedNote, source, target, send, onToast, sectionRef }: {
  patch: string
  /** Shown under the diff when git cut it; the caller knows how to see the rest. */
  truncatedNote?: string
  /** Names the diff in the message ("the committed changes", "checkpoint #3 → #4"). */
  source: string
  target: SendTarget
  send: (id: string, data: string) => Promise<unknown>
  onToast: (message: string, tone: 'info' | 'error') => void
  sectionRef?: (path: string, el: HTMLElement | null) => void
}) {
  const [review, dispatch] = useReducer(reviewReducer, emptyReview)
  const [composing, setComposing] = useState<Anchor | null>(null)
  const [editing, setEditing] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const sections = useMemo(() => patchSections(patch), [patch])
  const matched = useMemo(() => matchComments(review.comments, sections), [review.comments, sections])

  const finish = (): void => { setComposing(null); setEditing(null) }
  const sendReview = async (): Promise<void> => {
    setBusy(true)
    try {
      const delivery = await deliverReview({ source, comments: review.comments, outdated: new Set(matched.outdated.map((c) => c.id)), target, send })
      onToast(delivery.message, delivery.ok ? 'info' : 'error')
      dispatch({ type: 'delivered', delivery })
      if (delivery.ok) finish()
    } finally { setBusy(false) }
  }

  return (
    <>
      <ReviewBar count={review.comments.length} outdated={matched.outdated} targetName={target.name} busy={busy}
        onSend={() => { void sendReview() }} onClear={() => { dispatch({ type: 'clear' }); finish() }}
        onDeleteOutdated={(id) => dispatch({ type: 'delete', id })} />
      <div class="cockpit-changes__patch">
        <DiffLines sections={sections} byLine={matched.byLine} composing={composing} editing={editing}
          onCompose={(a) => { setEditing(null); setComposing(a) }}
          onAdd={(a, text) => { dispatch({ type: 'add', anchor: a, text }); setComposing(null) }}
          onCancel={finish}
          onEdit={(id) => { setComposing(null); setEditing(id) }}
          onSave={(id, text) => { dispatch({ type: 'edit', id, text }); setEditing(null) }}
          onDelete={(id) => dispatch({ type: 'delete', id })}
          sectionRef={sectionRef} />
        {truncatedNote !== undefined ? <p class="cockpit-muted cockpit-changes__note">{truncatedNote}</p> : null}
      </div>
    </>
  )
}
