import { useEffect, useRef, useState } from 'preact/hooks'
import { normalizeUrl } from '../lib/surfaces'

/** The subset of Electron's <webview> element this pane drives. */
type WebviewElement = HTMLElement & {
  loadURL(url: string): Promise<void>
  goBack(): void
  goForward(): void
  reload(): void
  canGoBack(): boolean
  canGoForward(): boolean
  getURL(): string
}

/**
 * A web page beside the terminals — a dev server, docs. The <webview> is locked down
 * in the main process (no Node, no preload, sandboxed, http(s) only; see
 * hardenWebviews), and the address bar only accepts http(s) (normalizeUrl).
 */
export function BrowserPane({ url, onNavigate }: { url: string; onNavigate: (url: string) => void }) {
  const ref = useRef<WebviewElement | null>(null)
  const [address, setAddress] = useState(url)
  const [error, setError] = useState<string | null>(null)
  const [nav, setNav] = useState({ back: false, forward: false })

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
    return () => {
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
        <button type="button" disabled={!nav.back} onClick={() => ref.current?.goBack()} aria-label="Back">‹</button>
        <button type="button" disabled={!nav.forward} onClick={() => ref.current?.goForward()} aria-label="Forward">›</button>
        <button type="button" onClick={() => ref.current?.reload()} aria-label="Reload">↻</button>
        <input
          value={address}
          placeholder="localhost:3000 or a URL"
          spellcheck={false}
          onInput={(e) => setAddress((e.target as HTMLInputElement).value)}
        />
      </form>
      {error ? <p class="cockpit-error cockpit-browser__error">{error}</p> : null}
      {/* partition: its own cookie jar, apart from anything else in the app. */}
      <webview ref={ref} class="cockpit-browser__view" src={initial} partition="persist:cockpit-browser" />
    </div>
  )
}
