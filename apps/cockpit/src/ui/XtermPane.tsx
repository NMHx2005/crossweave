import { useEffect, useRef } from 'preact/hooks'
import { Terminal } from '@xterm/xterm'
import { describeAttachFailure } from '../lib/attach-message'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { PaneSource } from '../lib/pane-source'
import { findFileLinks } from '../lib/file-links'
import { stripFocusReports, stripTerminalReports } from '../../../../src/client/terminal-reports.js'
import { clipboardWriteFromOsc52 } from '../../../../src/client/osc52.js'
import { XTERM_FONT_FAMILY, XTERM_FONT_SIZE, XTERM_THEME } from './tokens'

export type XtermPaneProps = {
  source: PaneSource
  focused: boolean
}

export function XtermPane({ source, focused }: XtermPaneProps) {
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
      // Agents like Claude Code turn on mouse tracking (?1000/1002/1006), which hands
      // every drag to the agent — and on macOS xterm.js then offers NO way to select
      // text unless this is on. With it, Option+drag selects (as in iTerm2), so a
      // pane's output can be copied with Cmd+C.
      macOptionClickForcesSelection: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    termRef.current = term

    // An agent that tracks the mouse (Claude Code) makes its own selection and copies
    // it with OSC 52; xterm.js ignores that sequence, so the clipboard never changed.
    // Writes only — see clipboardWriteFromOsc52. The browser refuses a write from an
    // unfocused window, so a background agent cannot fill the clipboard unseen.
    const osc52 = term.parser.registerOscHandler(52, (data) => {
      const text = clipboardWriteFromOsc52(data)
      if (text !== undefined) void navigator.clipboard.writeText(text).catch(() => undefined)
      return true
    })

    // Cmd+click (Ctrl+click elsewhere) on `path[:line[:col]]` opens it in the user's
    // editor. Plain clicks stay the terminal's (or the agent's, when it tracks the mouse).
    const links = term.registerLinkProvider({
      provideLinks(y, callback) {
        const text = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? ''
        callback(findFileLinks(text).map((link) => ({
          range: { start: { x: link.start + 1, y }, end: { x: link.end, y } },
          text: text.slice(link.start, link.end),
          decorations: { pointerCursor: true, underline: true },
          activate(event: MouseEvent) {
            if (event.metaKey || event.ctrlKey) source.openLink(link.path, link.line, link.col)
          },
        })))
      },
    })

    let cancelled = false
    let lastCols = 0
    let lastRows = 0
    // The daemon replays scrollback during session.attach, and xterm answers the
    // agent's old terminal queries in it (device attributes, focus). Those answers
    // typed `^[[?1;2c` into Claude Code's prompt. Until shortly after the replay,
    // only terminal reports are dropped — keystrokes still go through.
    let replayAnsweredUntil = Number.POSITIVE_INFINITY

    // Listen BEFORE attach: the daemon replays scrollback during the attach call.
    // Raw VT — no strip-ANSI. M9 stripped CSI and turned spinners into spam lines.
    const unlisten = source.onData((chunk) => term.write(chunk))

    const applyFit = (): void => {
      fit.fit()
      if (cancelled) return
      if (term.cols === lastCols && term.rows === lastRows) return
      lastCols = term.cols
      lastRows = term.rows
      void source.resize(term.cols, term.rows).catch(() => undefined)
    }

    // The agent TUI runs on the terminal's ALTERNATE screen. When the process exits,
    // the terminal correctly restores the primary buffer — which is empty, because this
    // pane was created for an agent that only ever used the alt screen. So the pane goes
    // blank, with no hint that the agent is gone rather than the app broken. The CLI has
    // said "[session exited]" in this situation since M0 (src/cli/commands/attach.ts);
    // this is the same sentence, in the same place.
    const exitUnlisten = source.onExit((code) => {
      term.write(`\r\n\r\n${source.exitMessage(code)}\r\n`)
    })

    // Typing into a pane with nothing behind it used to be dropped without a word
    // (the IPC rejection was swallowed); say so, once.
    let notRunningShown = false

    const dataSub = term.onData((raw) => {
      if (cancelled) return
      const live = stripFocusReports(raw)
      const data = Date.now() < replayAnsweredUntil ? stripTerminalReports(live) : live
      if (data === '') return
      void source.input(data).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        if (notRunningShown || !/not running|No such terminal/i.test(message)) return
        notRunningShown = true
        term.write(`\r\n${source.notRunningMessage}\r\n`)
      })
    })

    void source
      .attach()
      .then(() => {
        replayAnsweredUntil = Date.now() + 500
        if (cancelled) {
          source.detach()
          return
        }
        applyFit()
        if (focusedRef.current) term.focus()
      })
      .catch((err: unknown) => {
        replayAnsweredUntil = 0
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
      links.dispose()
      osc52.dispose()
      unlisten()
      exitUnlisten()
      dataSub.dispose()
      observer.disconnect()
      source.detach()
      term.dispose()
      termRef.current = null
    }
  }, [source.key])

  useEffect(() => {
    if (focused) termRef.current?.focus()
    else termRef.current?.blur()
  }, [focused])

  return <div class="xterm-pane" ref={containerRef} data-pane-key={source.key} />
}
