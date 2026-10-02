import { useEffect, useRef, useState } from 'preact/hooks'
import type { Ref } from 'preact'
import { debugCheckLine, sendableText, type DebugBundle } from '../lib/debug-pane'
import { plainErrorMessage } from '../lib/cockpit-host'

type DebugPaneProps = {
  sessionName: string
  /** Changes whenever the session list does, so the bundle refetches after new work. */
  revision: number
  loadDebug: () => Promise<DebugBundle>
  /** Drafts the sendable text into the composer for this session (the preview still shows). */
  onSend: (text: string) => void
}

/**
 * The session's debug bundle in one pane: the check verdict with its failing tail,
 * the errors the terminal streams showed (the daemon's heuristic — labelled), the
 * diffstat, and the agent's latest words. "Send to session" drafts the failing text
 * into the composer — nothing is typed anywhere until the person sends it.
 *
 * The fetch is GATED on visibility + revision: the bundle costs the daemon a git
 * diff and an agent-log read, and hidden panes must not re-run that on every rail
 * invalidate. Becoming visible fetches once; a Refresh button says so on demand.
 */
/**
 * The bundle's presentation, PURE (no hooks): the sections, the Send button, the
 * empty/error states — testable by walking the tree, as the house does.
 */
export function DebugBundleView({ bundle, error, onSend, stale = false, onRefresh, rootRef }: {
  bundle: DebugBundle | null
  error: string | null
  onSend: (text: string) => void
  /** The revision moved while this pane was hidden: the numbers are old. */
  stale?: boolean
  onRefresh?: () => void
  rootRef?: Ref<HTMLDivElement>
}) {
  if (error !== null) {
    return <div class="cockpit-debug" ref={rootRef}><p class="cockpit-error" role="alert">{error}</p></div>
  }
  if (bundle === null) {
    return <div class="cockpit-debug" ref={rootRef}><p class="cockpit-debug__empty">Reading the session…</p></div>
  }
  const send = sendableText(bundle)
  const capped = bundle.diff.files.length < bundle.diff.total
  return (
    <div class="cockpit-debug" ref={rootRef}>
      <p class="cockpit-debug__head">
        agent: {bundle.agent ?? 'none'} — {bundle.activity}
        {stale ? ' (stale — refresh to read again)' : null}
        {onRefresh !== undefined ? <button type="button" class="cockpit-btn cockpit-btn--sm cockpit-btn--ghost" onClick={onRefresh}>Refresh</button> : null}
      </p>
      <section class="cockpit-debug__section">
        <h4 class="cockpit-debug__label">check</h4>
        {bundle.check === undefined ? (
          <p class="cockpit-debug__empty">never run</p>
        ) : (
          <>
            <p class={`cockpit-debug__check cockpit-debug__check--${bundle.check.state}`}>
              {debugCheckLine(bundle.check)}
            </p>
            {bundle.check.tail !== undefined && bundle.check.tail.trim() !== '' ? (
              <>
                <pre class="cockpit-debug__tail">{bundle.check.tail.trimEnd()}</pre>
                {send !== undefined ? <button type="button" class="cockpit-btn" onClick={() => onSend(send)}>Send to session…</button> : null}
              </>
            ) : null}
          </>
        )}
      </section>
      {bundle.errors.length > 0 ? (
        <section class="cockpit-debug__section">
          <h4 class="cockpit-debug__label">errors seen in the terminal (heuristic)</h4>
          <ul class="cockpit-debug__errors">
            {bundle.errors.map((e) => <li key={`${e.at}:${e.line}`} class="cockpit-debug__error">{e.line}</li>)}
          </ul>
          {send !== undefined && bundle.check?.tail === undefined ? (
            <button type="button" class="cockpit-btn" onClick={() => onSend(send)}>Send to session…</button>
          ) : null}
        </section>
      ) : null}
      <section class="cockpit-debug__section">
        <h4 class="cockpit-debug__label">diff</h4>
        {bundle.diff.total === 0 && bundle.diff.uncommitted === 0 ? (
          <p class="cockpit-debug__empty">nothing to land yet</p>
        ) : (
          <p class="cockpit-debug__diffhead">
            {capped ? `${bundle.diff.files.length} of ${bundle.diff.total} file(s)` : `${bundle.diff.total} file(s)`}, {bundle.diff.uncommitted} uncommitted
          </p>
        )}
        <ul class="cockpit-debug__files">
          {bundle.diff.files.map((f) => (
            <li key={f.path} class="cockpit-debug__file">{f.status === 'added' ? '+ ' : f.status === 'deleted' ? '− ' : ''}{f.path}</li>
          ))}
        </ul>
      </section>
      {bundle.latestWords !== undefined ? (
        <section class="cockpit-debug__section">
          <h4 class="cockpit-debug__label">latest words</h4>
          <p class="cockpit-debug__words">{bundle.latestWords}</p>
        </section>
      ) : null}
    </div>
  )
}

/**
 * The Debug pane: fetches the bundle when VISIBLE and the revision moved, once on
 * becoming visible, plus a Refresh button; then renders the pure view above.
 */
export function DebugPane({ sessionName, revision, loadDebug, onSend }: DebugPaneProps) {
  const [bundle, setBundle] = useState<DebugBundle | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  /** The revision this view already shows; a change while hidden waits for visibility. */
  const seenRevision = useRef<number | null>(null)
  /** Cancels the in-flight fetch a newer one replaces (no out-of-order writes). */
  const cancelFetchRef = useRef<() => void>(() => undefined)
  const loadRef = useRef(loadDebug)
  loadRef.current = loadDebug

  const fetchNow = (): void => {
    cancelFetchRef.current()
    seenRevision.current = revision
    setStale(false)
    let cancelled = false
    cancelFetchRef.current = () => { cancelled = true }
    loadRef.current()
      .then((b) => { if (!cancelled) { setBundle(b); setError(null) } })
      .catch((err: unknown) => { if (!cancelled) setError(plainErrorMessage(err)) })
  }

  useEffect(() => {
    const root = rootRef.current
    if (root === null) return
    // A project off the stage is display:none → width 0: skip the fetch, mark the
    // view stale, fetch once when shown again.
    const visible = (): boolean => root.clientWidth > 0 && root.clientHeight > 0
    if (visible() && seenRevision.current !== revision) fetchNow()
    else if (seenRevision.current !== null && seenRevision.current !== revision) setStale(true)
    const observer = new ResizeObserver(() => {
      if (visible() && seenRevision.current !== revision) fetchNow()
    })
    observer.observe(root)
    return () => { cancelFetchRef.current(); observer.disconnect() }
  }, [revision])

  return <DebugBundleView bundle={bundle} error={error} onSend={onSend} stale={stale} onRefresh={fetchNow} rootRef={rootRef} />
}
