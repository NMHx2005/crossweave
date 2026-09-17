import { useEffect, useRef } from 'preact/hooks'
import { Terminal } from '@xterm/xterm'
import { describeAttachFailure } from '../lib/attach-message'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { cockpitApi } from '../host/cockpit-api'
import { decodeSessionData } from '../lib/session-data'
import { XTERM_FONT_FAMILY, XTERM_FONT_SIZE, XTERM_THEME } from './tokens'

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
      // Named, not inlined: the pane's palette and the chrome's come from the
      // same tokens object, so they cannot drift apart (they used to).
      fontFamily: XTERM_FONT_FAMILY,
      fontSize: XTERM_FONT_SIZE,
      scrollback: 5000,
      theme: XTERM_THEME,
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
        // Never the raw IPC message: it names the transport channel and the error
        // class, and the one failure a user can act on deserves the sentence that
        // tells them how (src/lib/attach-message.ts).
        term.write(`\r\n[${describeAttachFailure(message)}]\r\n`)
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
