import { useEffect, useReducer, useRef } from 'preact/hooks'
import { Terminal } from '@xterm/xterm'
import { describeAttachFailure } from '../lib/attach-message'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search'
import { CLOSED_FIND, findLabel, findReducer, type FindState } from '../lib/find-state'
import '@xterm/xterm/css/xterm.css'
import type { PaneSource } from '../lib/pane-source'
import { findFileLinks } from '../lib/file-links'
import { stripFocusReports, stripTerminalReports } from '../../../../src/client/terminal-reports.js'
import { clipboardWriteFromOsc52 } from '../../../../src/client/osc52.js'
import { droppedPathsText, isFileDrag } from '../lib/dropped-paths'
import { RendererCoordinator } from '../lib/terminal-renderer'
import { xtermLook } from '../lib/terminal-look'
import { usePaneTheme, useTerminalLook } from './terminal-look-context'

/**
 * One coordinator for the window: every pane asks it for a GPU renderer, and it keeps the
 * live WebGL contexts under Chromium's cap. Without WebGL2 (or when the addon fails to
 * load) a pane simply stays on xterm's DOM renderer.
 */
const glRenderers = new RendererCoordinator<WebglAddon>(() =>
  typeof WebGL2RenderingContext === 'undefined' ? undefined : new WebglAddon(),
)

export type XtermPaneProps = {
  source: PaneSource
  focused: boolean
}

export function XtermPane({ source, focused }: XtermPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const focusedRef = useRef(focused)
  focusedRef.current = focused
  const paneTheme = usePaneTheme()
  const paneThemeRef = useRef(paneTheme)
  paneThemeRef.current = paneTheme
  const look = xtermLook(useTerminalLook(), paneTheme.xterm)
  const lookRef = useRef(look)
  lookRef.current = look
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const [find, dispatchFind] = useReducer(findReducer, CLOSED_FIND)
  const findRef = useRef(find)
  findRef.current = find
  const findInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      convertEol: false,
      // The cockpit's palette and font (from the same tokens as the chrome, so they
      // cannot drift), or what Settings → Terminal imported over them.
      ...lookRef.current,
      scrollback: 5000,
      // Agents like Claude Code turn on mouse tracking (?1000/1002/1006), which hands
      // every drag to the agent — and on macOS xterm.js then offers NO way to select
      // text unless this is on. With it, Option+drag selects (as in iTerm2), so a
      // pane's output can be copied with Cmd+C.
      macOptionClickForcesSelection: true,
      // For `term.unicode` below — xterm still marks it experimental.
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    fitRef.current = fit
    term.loadAddon(fit)
    // xterm's built-in width table is Unicode 6: an emoji is one cell, where Claude
    // Code (and every current terminal) counts two. Its status line (📂, 🟢, …) then
    // overran its line by a cell per emoji, wrapped, and the redraw left doubled or cut
    // lines ("17:1") until the next full repaint. Unicode 11 widths agree with it.
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    const search = new SearchAddon({ highlightLimit: 2000 })
    term.loadAddon(search)
    searchRef.current = search
    const searchResults = search.onDidChangeResults((r) => dispatchFind({ type: 'results', resultIndex: r.resultIndex, resultCount: r.resultCount }))
    term.open(container)
    termRef.current = term

    // A project off the stage is display:none, so its panes measure 0x0: that is the
    // visibility signal, the same one applyFit uses. The GPU renderer attaches after
    // open() because it needs the canvas's parent.
    const isVisible = (): boolean => container.clientWidth > 0 && container.clientHeight > 0
    const syncRenderer = (): void => {
      if (cancelled) return
      const visible = isVisible()
      if (glRenderers.active(source.key)) {
        glRenderers.setVisible(source.key, visible)
        return
      }
      glRenderers.acquire(source.key, {
        visible,
        load: (addon) => term.loadAddon(addon),
        // Falls back to the DOM renderer, which draws from the buffer: repaint it whole.
        onFallback: () => { if (!cancelled) term.refresh(0, term.rows - 1) },
      })
    }

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
      // A project off the stage is display:none: its panes measure 0×0. Fitting then
      // would tell the shell its terminal shrank to nothing (and reflow its output);
      // the ResizeObserver fits again when the view is shown.
      if (container.clientWidth === 0 || container.clientHeight === 0) return
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
        const said = describeAttachFailure(message)
        if (said !== '') term.write(`\r\n[${said}]\r\n`)
      })

    const observer = new ResizeObserver(() => {
      applyFit()
      syncRenderer()
    })
    observer.observe(container)
    applyFit()
    syncRenderer()

    // A file dragged from Finder types its path, as in Ghostty and iTerm2. macOS asks the
    // app at dragenter whether it takes the drop: an uncancelled dragenter (or a cursor over
    // the pane's padding, outside the terminal box) sends the file flying back to Finder,
    // which is why the whole pane, not just the terminal, answers all three events.
    const zone = container.parentElement ?? container
    const onDragEnterOver = (e: DragEvent) => {
      if (!isFileDrag(e.dataTransfer?.types)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      zone.classList.add('is-file-drop')
    }
    const onDragLeave = (e: DragEvent) => {
      if (!zone.contains(e.relatedTarget as Node | null)) zone.classList.remove('is-file-drop')
    }
    const onDrop = (e: DragEvent) => {
      zone.classList.remove('is-file-drop')
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (files.length === 0) return
      e.preventDefault()
      // The stage's own drop handler moves panes; a file is not one.
      e.stopPropagation()
      const text = droppedPathsText(files.map((f) => window.cockpit.pathForFile(f)))
      // paste(), not input: a shell or agent that asked for bracketed paste gets one.
      if (text !== '') term.paste(text)
      term.focus()
    }
    zone.addEventListener('dragenter', onDragEnterOver)
    zone.addEventListener('dragover', onDragEnterOver)
    zone.addEventListener('dragleave', onDragLeave)
    zone.addEventListener('drop', onDrop)

    return () => {
      zone.removeEventListener('dragenter', onDragEnterOver)
      zone.removeEventListener('dragover', onDragEnterOver)
      zone.removeEventListener('dragleave', onDragLeave)
      zone.removeEventListener('drop', onDrop)
      zone.classList.remove('is-file-drop')
      cancelled = true
      links.dispose()
      osc52.dispose()
      unlisten()
      exitUnlisten()
      dataSub.dispose()
      observer.disconnect()
      searchResults.dispose()
      searchRef.current = null
      source.detach()
      // Before dispose: the addon must let go of its context while the terminal exists.
      glRenderers.release(source.key)
      term.dispose()
      termRef.current = null
    }
  }, [source.key])

  useEffect(() => {
    if (focused) termRef.current?.focus()
    else termRef.current?.blur()
  }, [focused])

  // Text from outside the terminal (the voice composer's Send) goes to the focused pane as
  // a paste, so an agent that asked for bracketed paste gets it as one paste; `enter` then
  // presses Enter as a keystroke.
  useEffect(() => {
    const onPaste = (ev: Event): void => {
      if (!focusedRef.current) return
      const detail = (ev as CustomEvent<{ text?: string; enter?: boolean }>).detail
      const term = termRef.current
      if (!term || typeof detail?.text !== 'string' || detail.text === '') return
      term.paste(detail.text)
      if (detail.enter === true) term.input('\r', true)
      term.focus()
    }
    window.addEventListener('cockpit:paste', onPaste)
    return () => window.removeEventListener('cockpit:paste', onPaste)
  }, [])

  // ⌘F / ⌘G / ⌘⇧G from the menu reach every pane; only the focused one (its tab and
  // its project shown) answers.
  useEffect(() => {
    const onFind = (ev: Event): void => {
      if (!focusedRef.current) return
      const action = (ev as CustomEvent<{ action?: string }>).detail?.action
      if (action === 'open') {
        dispatchFind({ type: 'open' })
        setTimeout(() => { findInputRef.current?.focus(); findInputRef.current?.select() }, 0)
      } else if (action === 'next' || action === 'prev') {
        if (!findRef.current.open) dispatchFind({ type: 'open' })
        runFind(findRef.current, action)
      }
    }
    window.addEventListener('cockpit:find', onFind)
    return () => window.removeEventListener('cockpit:find', onFind)
  }, [])

  /** Search `state.term`; `incremental` keeps the current match while typing extends it. */
  function runFind(state: FindState, direction: 'next' | 'prev', incremental = false): void {
    const search = searchRef.current
    if (!search) return
    if (state.term === '') {
      search.clearDecorations()
      return
    }
    const options: ISearchOptions = {
      caseSensitive: state.caseSensitive,
      regex: state.regex,
      wholeWord: state.wholeWord,
      incremental,
      // Hex only (the addon's rule), from the current theme's tokens.
      decorations: {
        matchBackground: paneThemeRef.current.colors['--cw-surface-control'] as string,
        matchOverviewRuler: paneThemeRef.current.colors['--cw-text-dim'] as string,
        activeMatchBackground: paneThemeRef.current.colors['--cw-surface-active'] as string,
        activeMatchBorder: paneThemeRef.current.colors['--cw-needs-you'] as string,
        activeMatchColorOverviewRuler: paneThemeRef.current.colors['--cw-needs-you'] as string,
      },
    }
    try {
      if (direction === 'next') search.findNext(state.term, options)
      else search.findPrevious(state.term, options)
    } catch {
      // an unfinished regex while typing: no matches yet
      dispatchFind({ type: 'results', resultIndex: -1, resultCount: 0 })
    }
  }

  function closeFind(): void {
    dispatchFind({ type: 'close' })
    searchRef.current?.clearDecorations()
    termRef.current?.focus()
  }

  // Settings → Terminal saved (or an import applied): every open pane changes in place,
  // then refits, because a new font or size changes how many cells fit.
  const lookKey = JSON.stringify(look)
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    const next = lookRef.current
    term.options.fontFamily = next.fontFamily
    term.options.fontSize = next.fontSize
    term.options.theme = next.theme
    term.options.cursorStyle = next.cursorStyle
    term.options.cursorBlink = next.cursorBlink
    term.options.macOptionIsMeta = next.macOptionIsMeta
    const container = containerRef.current
    if (container && container.clientWidth > 0 && container.clientHeight > 0) fitRef.current?.fit()
  }, [lookKey])

  return (
    <div class="xterm-pane__wrap">
      {/* The pane is painted in the terminal's own background: xterm fills whole rows
          only, and the strip left under the last one showed its stylesheet's black. */}
      <div class="xterm-pane" ref={containerRef} data-pane-key={source.key} style={{ background: look.theme.background }} />
      {find.open ? (
        <div class="cockpit-find" role="search" aria-label="Find in terminal">
          <input
            ref={findInputRef}
            value={find.term}
            placeholder="Find"
            aria-label="Find"
            spellcheck={false}
            onInput={(ev) => {
              const next = findReducer(find, { type: 'term', term: (ev.target as HTMLInputElement).value })
              dispatchFind({ type: 'term', term: next.term })
              runFind(next, 'next', true)
            }}
            onKeyDown={(ev) => {
              if (ev.isComposing) return
              if (ev.key === 'Enter') { ev.preventDefault(); runFind(find, ev.shiftKey ? 'prev' : 'next') }
              else if (ev.key === 'Escape') { ev.preventDefault(); closeFind() }
            }}
          />
          <span class="cockpit-find__count" aria-live="polite">{findLabel(find)}</span>
          {([['caseSensitive', 'Aa', 'Match case'], ['wholeWord', 'ab', 'Whole word'], ['regex', '.*', 'Regular expression']] as const).map(([option, glyph, title]) => (
            <button key={option} type="button" class={`cockpit-find__toggle${find[option] ? ' is-on' : ''}`} title={title} aria-pressed={find[option]}
              onClick={() => {
                const next = findReducer(find, { type: 'toggle', option })
                dispatchFind({ type: 'toggle', option })
                runFind(next, 'next', true)
                findInputRef.current?.focus()
              }}>{glyph}</button>
          ))}
          <button type="button" class="cockpit-iconbtn cockpit-find__nav" title="Previous (⌘⇧G)" aria-label="Previous match" onClick={() => runFind(find, 'prev')}>↑</button>
          <button type="button" class="cockpit-iconbtn cockpit-find__nav" title="Next (⌘G)" aria-label="Next match" onClick={() => runFind(find, 'next')}>↓</button>
          <button type="button" class="cockpit-iconbtn cockpit-find__nav" title="Close (Esc)" aria-label="Close find" onClick={closeFind}>×</button>
        </div>
      ) : null}
    </div>
  )
}
