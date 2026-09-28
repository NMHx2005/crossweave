import { useEffect, useState } from 'preact/hooks'
import type { SessionHistoryEntry } from '../lib/session-history'

function formatEnded(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

/**
 * Sessions that were landed or removed: their own row is gone (`session rm`, `kill
 * --rm-worktree`, `gc`), but `session.history` keeps a snapshot of each one. Read-only
 * — there is nothing left to act on, only to remember.
 */
export function SessionHistoryDialog({ load, onClose }: {
  load: () => Promise<SessionHistoryEntry[]>
  onClose: () => void
}) {
  const [rows, setRows] = useState<SessionHistoryEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    load()
      .then((r) => { if (live) setRows(r) })
      .catch((err) => { if (live) setError(String((err as Error)?.message ?? err)) })
    return () => { live = false }
  }, [load])

  return (
    <div class="cockpit-picker__backdrop" onClick={onClose}>
      <div class="cockpit-picker cockpit-session-history" role="dialog" aria-label="Session history"
        onClick={(ev) => ev.stopPropagation()} onKeyDown={(ev) => { if (ev.code === 'Escape') onClose() }}>
        <h2 class="cockpit-picker__title">Session history</h2>
        {error !== null ? (
          <p class="cockpit-error" role="alert">{error}</p>
        ) : rows === null ? (
          <p class="cockpit-placeholder">Loading…</p>
        ) : rows.length === 0 ? (
          <p class="cockpit-placeholder">No sessions have been landed or removed yet.</p>
        ) : (
          <table class="cockpit-session-history__table">
            <thead>
              <tr><th>Name</th><th>Status</th><th>Branch</th><th>Ended</th><th>Tokens</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.name}-${r.endedAt}`}>
                  <td>{r.name}</td>
                  <td class={r.finalStatus === 'landed' ? 'is-landed' : 'is-dead'}>{r.finalStatus}</td>
                  <td>{r.branch ?? '-'}</td>
                  <td>{formatEnded(r.endedAt)}</td>
                  <td>{r.tokenSpent}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div class="cockpit-picker__actions">
          <button type="button" class="cockpit-btn cockpit-btn--primary" autoFocus onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
