/** @jsxImportSource preact */
import { useEffect, useState } from 'preact/hooks'
import { describeRestore, type Checkpoint, type CheckpointDiff, type RestorePlan } from '../lib/checkpoints'
import type { SendTarget } from '../lib/prompt-send'
import { plainErrorMessage } from '../lib/cockpit-host'
import { relativeTime } from '../lib/rail'
import { CommentableDiff } from './CommentableDiff'
import { SensitiveBadge, SensitiveSummary } from './SensitiveBadge'
import type { ConfirmRequest } from './ConfirmDialog'

const STATUS_MARK = { added: 'A', modified: 'M', deleted: 'D' } as const

/** The rows alone — pure, so it is walk-tested; the dialog below owns the state and the calls. */
export function CheckpointList({ rows, now, onTurn, onSince, onRestore }: {
  rows: readonly Checkpoint[]
  now: number
  onTurn: (seq: number) => void
  onSince: (seq: number) => void
  onRestore: (seq: number) => void
}) {
  if (rows.length === 0) {
    return <p class="cockpit-placeholder">No checkpoints yet — one is taken when an agent starts or finishes a turn, or press Checkpoint now.</p>
  }
  return (
    <ul class="cockpit-checkpoints__list" aria-label="Checkpoints, newest first">
      {rows.map((c, i) => {
        const ago = relativeTime(c.at, now)
        const oldest = i === rows.length - 1
        return (
          <li key={c.seq} class="cockpit-checkpoints__row">
            <span class="cockpit-checkpoints__seq">{`#${c.seq}`}</span>
            <span class="cockpit-muted">{c.kind}</span>
            {c.label !== undefined ? <span>{c.label}</span> : null}
            <span class="cockpit-changes__count">{`+${c.files.added} ~${c.files.modified} −${c.files.deleted}`}</span>
            {ago !== undefined ? <span class="cockpit-muted">{ago}</span> : null}
            <span class="cockpit-checkpoints__actions">
              <button type="button" class="cockpit-btn cockpit-btn--sm" disabled={oldest}
                title={oldest ? 'The oldest checkpoint has no earlier one to compare with' : 'What changed between the previous checkpoint and this one'}
                onClick={() => onTurn(c.seq)}>This turn</button>
              <button type="button" class="cockpit-btn cockpit-btn--sm" title="What changed since this checkpoint, up to now" onClick={() => onSince(c.seq)}>Since</button>
              <button type="button" class="cockpit-btn cockpit-btn--sm cockpit-btn--danger" onClick={() => onRestore(c.seq)}>Restore…</button>
            </span>
          </li>
        )
      })}
    </ul>
  )
}

type Shown = { title: string; diff: CheckpointDiff } | { error: string } | undefined

export function CheckpointsDialog({ sessionName, target, send, working, revision, load, take, loadDiff, preview, restore, askConfirm, onToast, onClose }: {
  sessionName: string
  /** Where "Send comments" goes: this session's shell. */
  target: SendTarget
  send: (id: string, data: string) => Promise<unknown>
  /** The session looks busy (inferred): the confirmation says so, and the restore is sent forced. */
  working: boolean
  /** Changes whenever the session list does, so the rows refresh after a turn ends. */
  revision: number
  load: () => Promise<Checkpoint[]>
  take: () => Promise<unknown>
  loadDiff: (from: number, to?: number) => Promise<CheckpointDiff>
  preview: (seq: number) => Promise<RestorePlan>
  restore: (seq: number, force: boolean) => Promise<unknown>
  askConfirm: (request: ConfirmRequest) => Promise<boolean>
  onToast: (message: string, tone: 'info' | 'error') => void
  onClose: () => void
}) {
  const [rows, setRows] = useState<Checkpoint[]>([])
  const [error, setError] = useState<string | null>(null)
  const [shown, setShown] = useState<Shown>(undefined)
  const [busy, setBusy] = useState(false)

  const reload = (): void => {
    load().then((next) => { setRows(next); setError(null) }, (err: unknown) => setError(plainErrorMessage(err)))
  }
  // `load` is a fresh closure on every render; the revision is what decides a refetch.
  useEffect(reload, [revision])

  const show = (title: string, from: number, to?: number): void => {
    setShown(undefined)
    loadDiff(from, to).then((diff) => setShown({ title, diff }), (err: unknown) => setShown({ error: plainErrorMessage(err) }))
  }

  const takeNow = async (): Promise<void> => {
    setBusy(true)
    try {
      const out = (await take()) as { unchanged?: boolean } | null
      onToast(out?.unchanged === true ? 'Nothing changed since the last checkpoint' : 'Checkpoint taken', 'info')
      reload()
    } catch (err) { onToast(plainErrorMessage(err), 'error') } finally { setBusy(false) }
  }

  const restoreAsk = async (seq: number): Promise<void> => {
    setBusy(true)
    try {
      const plan = await preview(seq)
      const words = describeRestore(seq, plan, working)
      if (plan.write.length + plan.delete.length === 0) { onToast(words.body, 'info'); return }
      if (!(await askConfirm({ title: words.title, body: words.body, confirmLabel: 'Restore', danger: true }))) return
      await restore(seq, working)
      onToast(`Restored checkpoint #${seq}`, 'info')
      reload()
    } catch (err) { onToast(plainErrorMessage(err), 'error') } finally { setBusy(false) }
  }

  return (
    <div class="cockpit-picker__backdrop" onClick={onClose}>
      <div class="cockpit-picker cockpit-checkpoints" role="dialog" aria-label={`Checkpoints for ${sessionName}`}
        onClick={(ev) => ev.stopPropagation()} onKeyDown={(ev) => { if (ev.code === 'Escape') onClose() }}>
        <h2 class="cockpit-picker__title">{`Checkpoints — ${sessionName}`}</h2>
        {error !== null ? <p class="cockpit-error" role="alert">{error}</p> : null}
        <CheckpointList rows={rows} now={Date.now()} onTurn={(seq) => {
          const before = rows[rows.findIndex((r) => r.seq === seq) + 1]
          if (before !== undefined) show(`#${before.seq} → #${seq}`, before.seq, seq)
        }} onSince={(seq) => show(`#${seq} → now`, seq)} onRestore={(seq) => { void restoreAsk(seq) }} />
        {shown !== undefined && 'error' in shown ? <p class="cockpit-error" role="alert">{shown.error}</p> : null}
        {shown !== undefined && 'diff' in shown ? (
          <div class="cockpit-changes__patch">
            <h3 class="cockpit-changes__file">{`${shown.title} · ${shown.diff.files.length} file${shown.diff.files.length === 1 ? '' : 's'}`}</h3>
            <SensitiveSummary paths={shown.diff.files.map((f) => f.path)} />
            <ul class="cockpit-changes__files">
              {shown.diff.files.map((f) => (
                <li key={f.path}>
                  <span class={`cockpit-changes__mark is-${f.status}`}>{STATUS_MARK[f.status]}</span>
                  <span class="cockpit-changes__path">{f.path}</span>
                  <SensitiveBadge path={f.path} />
                  <span class="cockpit-changes__count">{`+${f.added} −${f.deleted}`}</span>
                </li>
              ))}
            </ul>
            <CommentableDiff key={shown.title} patch={shown.diff.patch} source={`checkpoint ${shown.title}`} target={target} send={send} onToast={onToast}
              truncatedNote={shown.diff.truncated ? 'The diff is longer than shown — `cw checkpoint diff` prints the rest.' : undefined} />
          </div>
        ) : null}
        <div class="cockpit-picker__actions">
          <button type="button" class="cockpit-btn" disabled={busy} onClick={() => { void takeNow() }}>Checkpoint now</button>
          <button type="button" class="cockpit-btn cockpit-btn--primary" autoFocus onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
