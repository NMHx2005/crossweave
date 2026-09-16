import { useEffect, useRef } from 'preact/hooks'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { cockpitApi } from '../host/cockpit-api'
import { decodeSessionData } from '../lib/session-data'

export type XtermPaneProps = {
  sessionId: string
  focused: boolean
}

export function XtermPane({ sessionId, focused }: XtermPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const focusedRef = useRef(focused)
  focusedRef.current = focused

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      scrollback: 5000,
      theme: {
        background: '#0f1115',
        foreground: '#e8eaed',
        cursor: '#e8eaed',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    termRef.current = term

    let cancelled = false
    let lastCols = 0
    let lastRows = 0

    // Listen BEFORE attach: the daemon replays scrollback during session.attach.
    const unlisten = cockpitApi.onSessionData((payload) => {
      const decoded = decodeSessionData(payload)
      if (!decoded || decoded.sessionId !== sessionId) return
      // Raw VT — no strip-ANSI. M9 stripped CSI and turned spinners into spam lines.
      term.write(decoded.chunk)
    })

    const applyFit = (): void => {
      fit.fit()
      if (cancelled) return
      if (term.cols === lastCols && term.rows === lastRows) return
      lastCols = term.cols
      lastRows = term.rows
      void cockpitApi.resizeSession(sessionId, term.cols, term.rows).catch(() => undefined)
    }

    const dataSub = term.onData((data) => {
      if (cancelled) return
      void cockpitApi.sendInput(sessionId, data).catch(() => undefined)
    })

    void cockpitApi
      .attachSession(sessionId)
      .then(() => {
        if (cancelled) {
          void cockpitApi.detachSession(sessionId)
          return
        }
        applyFit()
        if (focusedRef.current) term.focus()
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        term.write(`\r\n[attach failed: ${message}]\r\n`)
      })

    const observer = new ResizeObserver(() => applyFit())
    observer.observe(container)
    applyFit()

    return () => {
      cancelled = true
      unlisten()
      dataSub.dispose()
      observer.disconnect()
      void cockpitApi.detachSession(sessionId)
      term.dispose()
      termRef.current = null
    }
  }, [sessionId])

  useEffect(() => {
    if (focused) termRef.current?.focus()
    else termRef.current?.blur()
  }, [focused])

  return <div class="xterm-pane" ref={containerRef} data-session-id={sessionId} />
}
