import { cockpitApi } from '../host/cockpit-api'
import { decodeSessionData } from './session-data'

/**
 * What an xterm pane is connected to: a session's own shell, or an extra Terminal pane's.
 * The pane itself (fit, replay-answer filtering, OSC 52, copy/paste) is the same for
 * both; only where bytes come from and go to differs.
 */
export type PaneSource = {
  /** Stable identity: re-attach when it changes. */
  key: string
  attach(): Promise<unknown>
  detach(): void
  input(data: string): Promise<unknown>
  resize(cols: number, rows: number): Promise<unknown>
  onData(cb: (chunk: string | Uint8Array) => void): () => void
  onExit(cb: (code: number | undefined) => void): () => void
  exitMessage(code: number | undefined): string
  /** Shown once when input is refused because nothing is running behind the pane. */
  notRunningMessage: string
  /** Cmd+click on a file path in the output: open it in the user's editor. */
  openLink(path: string, line?: number, col?: number): void
}

const exitCode = (payload: unknown): number | undefined => {
  const code = (payload as { code?: unknown } | null)?.code
  return typeof code === 'number' ? code : undefined
}

const codeSuffix = (code: number | undefined): string => (code === undefined ? '' : ` (code ${code})`)

/** Opens a file in the cockpit's own editor pane (editor setting `cockpit`). */
export type InAppOpener = (sessionId: string, path: string, line?: number) => void

function linkOpener(sessionId: string, inApp?: InAppOpener) {
  return (path: string, line?: number, col?: number): void => {
    void cockpitApi.openInEditor(sessionId, path, line, col).then((r) => {
      if (r.inApp && typeof r.path === 'string') inApp?.(sessionId, r.path, r.line)
    })
  }
}

export function sessionSource(sessionId: string, inApp?: InAppOpener): PaneSource {
  return {
    key: `session:${sessionId}`,
    attach: () => cockpitApi.attachSession(sessionId),
    detach: () => { void cockpitApi.detachSession(sessionId) },
    input: (data) => cockpitApi.sendInput(sessionId, data),
    resize: (cols, rows) => cockpitApi.resizeSession(sessionId, cols, rows),
    onData: (cb) => cockpitApi.onSessionData((payload) => {
      const decoded = decodeSessionData(payload)
      if (decoded && decoded.sessionId === sessionId) cb(decoded.chunk)
    }),
    onExit: (cb) => cockpitApi.onSessionExit((payload) => {
      if ((payload as { sessionId?: unknown } | null)?.sessionId === sessionId) cb(exitCode(payload))
    }),
    exitMessage: (code) => `[session exited${codeSuffix(code)} — press Start to bring it back]`,
    notRunningMessage: '[not running]',
    openLink: linkOpener(sessionId, inApp),
  }
}

export function terminalSource(terminalId: string, sessionId: string, inApp?: InAppOpener): PaneSource {
  return {
    key: `terminal:${terminalId}`,
    attach: () => cockpitApi.attachTerminal(terminalId),
    // A terminal lives until it is closed; leaving the pane does not end the shell.
    detach: () => undefined,
    input: (data) => cockpitApi.terminalInput(terminalId, data),
    resize: (cols, rows) => cockpitApi.resizeTerminal(terminalId, cols, rows),
    onData: (cb) => cockpitApi.onTerminalData((payload) => {
      if ((payload as { terminalId?: unknown } | null)?.terminalId !== terminalId) return
      const decoded = decodeSessionData(payload)
      if (decoded) cb(decoded.chunk)
    }),
    onExit: (cb) => cockpitApi.onTerminalExit((payload) => {
      if ((payload as { terminalId?: unknown } | null)?.terminalId === terminalId) cb(exitCode(payload))
    }),
    exitMessage: (code) => `[shell exited${codeSuffix(code)}]`,
    notRunningMessage: '[this shell has exited — close the pane or open a new Terminal]',
    // A shell sits in its session's worktree, so its paths resolve there too.
    openLink: linkOpener(sessionId, inApp),
  }
}
