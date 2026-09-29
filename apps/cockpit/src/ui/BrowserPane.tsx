import { useEffect, useRef, useState } from 'preact/hooks'
import { normalizeUrl } from '../lib/surfaces'
import { cockpitApi } from '../host/cockpit-api'

export type AccessLevel = 'off' | 'read' | 'control'
/** What the person can tell the agent apart by: the level, in words. */
const LEVELS: ReadonlyArray<{ level: AccessLevel; label: string; hint: string }> = [
  { level: 'off', label: 'Off', hint: 'The agent in this session cannot see this page' },
  { level: 'read', label: 'Read', hint: 'The agent can read the console, requests, page text and a screenshot' },
  { level: 'control', label: 'Control', hint: 'The agent can also navigate, click, type and run script (it asks you off localhost, and always for script)' },
]
const ACTIVITY_KEPT = 50
interface Action { t: number; command: string; target: string }
const clock = (t: number): string => new Date(t).toTimeString().slice(0, 8)

/** The subset of Electron's <webview> element this pane drives. */
type WebviewElement = HTMLElement & {
  loadURL(url: string): Promise<void>
  goBack(): void
  goForward(): void
  reload(): void
  canGoBack(): boolean
  canGoForward(): boolean
  getURL(): string
  getWebContentsId(): number
}

/**
 * A web page beside the terminals — a dev server, docs. The <webview> is locked down
 * in the main process (no Node, no preload, sandboxed, http(s) only; see
 * hardenWebviews), and the address bar only accepts http(s) (normalizeUrl).
 */
export function BrowserPane({ paneId, url, onNavigate, setAccess }: {
  paneId: string
  url: string
  onNavigate: (url: string) => void
  /** Tell the main process the level; it validates the webview and does the enforcing. */
  setAccess: (paneId: string, webContentsId: number, level: AccessLevel) => Promise<{ ok: boolean; message?: string }>
}) {
  const ref = useRef<WebviewElement | null>(null)
  const [address, setAddress] = useState(url)
  const [error, setError] = useState<string | null>(null)
  const [nav, setNav] = useState({ back: false, forward: false })
  // View state only: a pane starts at off every time, and nothing here is saved or sent to the daemon.
  const [level, setLevel] = useState<AccessLevel>('off')
  const [ready, setReady] = useState(false)
  const [actions, setActions] = useState<Action[]>([])
  const [showActions, setShowActions] = useState(false)

  const choose = (next: AccessLevel): void => {
    const view = ref.current
    if (view === null || !ready) return
    void setAccess(paneId, view.getWebContentsId(), next).then((res) => {
      if (res.ok) { setLevel(next); setError(null) } else setError(res.message ?? 'The cockpit could not change access to this page')
    })
  }

  // What an agent just did here; a 'detached' means the debugger went away (DevTools?) and access fell back to off.
  useEffect(() => cockpitApi.onBrowserActivity((payload) => {
    const a = payload as { t?: unknown; paneId?: unknown; command?: unknown; target?: unknown } | null
    if (a?.paneId !== paneId || typeof a.command !== 'string' || typeof a.t !== 'number') return
    if (a.command === 'detached') { setLevel('off'); setError('Agent access was switched off: another debugger took this page'); return }
    const action = { t: a.t, command: a.command, target: typeof a.target === 'string' ? a.target : '' }
    setActions((prev) => [...prev.slice(-(ACTIVITY_KEPT - 1)), action])
  }), [paneId])

  useEffect(() => {
    const view = ref.current
    if (!view) return
    const onDidNavigate = (): void => {
      const now = view.getURL()
      setAddress(now)
      setNav({ back: view.canGoBack(), forward: view.canGoForward() })
      onNavigate(now)
    }
    const onFail = (e: Event): void => {
      const code = (e as Event & { errorCode?: number; errorDescription?: string })
      // -3 is an aborted load (a redirect or a new navigation), not a failure.
      if (code.errorCode !== -3) setError(`Could not load: ${code.errorDescription ?? 'unknown error'}`)
    }
    view.addEventListener('did-navigate', onDidNavigate)
    view.addEventListener('did-navigate-in-page', onDidNavigate)
    view.addEventListener('did-fail-load', onFail)
    // The guest exists (and has an id main can validate) from dom-ready; register it at off.
    const onReady = (): void => {
      void setAccess(paneId, view.getWebContentsId(), 'off').then((res) => { if (res.ok) setReady(true) })
    }
    view.addEventListener('dom-ready', onReady, { once: true })
    return () => {
      view.removeEventListener('dom-ready', onReady)
      view.removeEventListener('did-navigate', onDidNavigate)
      view.removeEventListener('did-navigate-in-page', onDidNavigate)
      view.removeEventListener('did-fail-load', onFail)
    }
  }, [])

  const go = (input: string): void => {
    const next = normalizeUrl(input)
    if (next === null) {
      setError('Only http and https addresses open here')
      return
    }
    setError(null)
    void ref.current?.loadURL(next).catch(() => undefined)
  }

  // Read once: the stage records every navigation in `url`, and feeding that back into
  // `src` would make the webview load each page a second time.
  // An empty src never attaches a guest page, and loadURL on an unattached webview does
  // nothing — so a pane opened with no address starts on about:blank.
  const [initial] = useState(() => normalizeUrl(url) ?? 'about:blank')
  return (
    <div class="cockpit-browser">
      <form class="cockpit-browser__bar" onSubmit={(e) => { e.preventDefault(); go(address) }}>
        <button type="button" class="cockpit-btn cockpit-btn--sm cockpit-btn--ghost" disabled={!nav.back} onClick={() => ref.current?.goBack()} aria-label="Back">‹</button>
        <button type="button" class="cockpit-btn cockpit-btn--sm cockpit-btn--ghost" disabled={!nav.forward} onClick={() => ref.current?.goForward()} aria-label="Forward">›</button>
        <button type="button" class="cockpit-btn cockpit-btn--sm cockpit-btn--ghost" onClick={() => ref.current?.reload()} aria-label="Reload">↻</button>
        <input
          value={address}
          placeholder="localhost:3000 or a URL"
          spellcheck={false}
          onInput={(e) => setAddress((e.target as HTMLInputElement).value)}
        />
        <div class="cockpit-browser__access" role="group" aria-label="Agent access to this page" data-level={level}>
          <span class="cockpit-browser__access-label">Agent</span>
          {LEVELS.map((l) => (
            <button
              type="button"
              key={l.level}
              class={`cockpit-btn cockpit-btn--sm cockpit-btn--ghost cockpit-browser__level${level === l.level ? ' is-active' : ''}`}
              aria-pressed={level === l.level}
              disabled={!ready}
              title={l.hint}
              onClick={() => choose(l.level)}
            >{l.label}</button>
          ))}
        </div>
      </form>
      {error ? <p class="cockpit-error cockpit-browser__error">{error}</p> : null}
      {/* partition: its own cookie jar, apart from anything else in the app. */}
      {actions.length > 0 ? (
        <div class="cockpit-browser__activity">
          <button type="button" class="cockpit-btn cockpit-btn--sm cockpit-btn--ghost" onClick={() => setShowActions((v) => !v)} aria-expanded={showActions}>
            {showActions ? '▾' : '▸'} {clock(actions[actions.length - 1]!.t)} agent: {actions[actions.length - 1]!.command} {actions[actions.length - 1]!.target}
          </button>
          {showActions ? (
            <ol class="cockpit-browser__log" aria-label="What the agent did here">
              {[...actions].reverse().map((a, i) => <li key={i}><time>{clock(a.t)}</time> {a.command} {a.target}</li>)}
            </ol>
          ) : null}
        </div>
      ) : null}
      <webview ref={ref} class="cockpit-browser__view" src={initial} partition="persist:cockpit-browser" />
    </div>
  )
}
