import { useEffect, useState } from 'preact/hooks'
import { cockpitApi, type ListedSession } from '../host/cockpit-api'
import { XtermPane } from './XtermPane'

export function App() {
  const [sessions, setSessions] = useState<ListedSession[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load(): Promise<void> {
      try {
        await cockpitApi.ensureWorkspace()
        const listed = await cockpitApi.listSessions()
        if (cancelled) return
        setSessions(listed)
        setSelectedId((current) => {
          if (current && listed.some((session) => session.id === current)) return current
          return listed[0]?.id ?? null
        })
        setStatus(listed.length === 0 ? 'empty' : 'ready')
        setError(null)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setStatus('error')
      }
    }

    void load()
    const unsub = cockpitApi.onTuiInvalidate(() => {
      void load()
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [])

  const selected = sessions.find((session) => session.id === selectedId) ?? null

  return (
    <div class="cockpit-shell">
      <aside class="cockpit-rail" aria-label="Agent rail">
        <header class="cockpit-rail__header">
          <h1>Cockpit</h1>
          <p class="cockpit-muted">Agent rail</p>
        </header>
        <p class="cockpit-placeholder">Sessions will appear here.</p>
      </aside>
      <main class="cockpit-stage" aria-label="Stage">
        <header class="cockpit-stage__header">
          <h2>Stage</h2>
          {selected ? (
            <label class="cockpit-session-pick">
              <span class="cockpit-muted">Session</span>
              <select
                value={selected.id}
                onChange={(event) => {
                  setSelectedId((event.currentTarget as HTMLSelectElement).value)
                }}
              >
                {sessions.map((session) => (
                  <option key={session.id} value={session.id}>
                    {session.name}
                    {session.status ? ` (${session.status})` : ''}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p class="cockpit-muted">Attach a running session to this pane.</p>
          )}
        </header>
        {status === 'loading' && <p class="cockpit-placeholder">Connecting to cwd…</p>}
        {status === 'error' && <p class="cockpit-placeholder">Workspace error: {error}</p>}
        {status === 'empty' && (
          <p class="cockpit-placeholder">
            No sessions. Start one with <code>cw session new</code> / <code>cw session start</code>,
            then reopen or wait for the list to refresh.
          </p>
        )}
        {status === 'ready' && selected && (
          <div class="cockpit-stage__pane">
            <XtermPane key={selected.id} sessionId={selected.id} focused />
          </div>
        )}
      </main>
    </div>
  )
}
