import type { CockpitChannel, CockpitEvent } from '../../electron/channels'

export type { CockpitChannel, CockpitEvent }

export type WorkspaceEnsureResult = {
  projectRoot: string
  workspace: { id: string; name: string; rootPath: string }
}

export type SessionAttachResult = {
  ok: boolean
  sessionId: string
  name: string
}

export function cockpitInvoke<T = unknown>(channel: CockpitChannel, payload?: unknown): Promise<T> {
  return window.cockpit.invoke(channel, payload) as Promise<T>
}

export function cockpitListen(event: CockpitEvent, cb: (payload: unknown) => void): () => void {
  return window.cockpit.listen(event, cb)
}

/** Typed renderer wrappers over the closed preload bridge. */
export const cockpitApi = {
  ensureWorkspace(projectRoot?: string): Promise<WorkspaceEnsureResult> {
    return cockpitInvoke('workspace.ensure', projectRoot ? { projectRoot } : undefined)
  },
  listSessions(): Promise<unknown> {
    return cockpitInvoke('session.list')
  },
  newSession(payload: { name: string; agent: string; worktree?: boolean }): Promise<unknown> {
    return cockpitInvoke('session.new', payload)
  },
  attachSession(idOrName: string): Promise<SessionAttachResult> {
    return cockpitInvoke('session.attach', { idOrName })
  },
  detachSession(sessionId: string): Promise<unknown> {
    return cockpitInvoke('session.detach', { sessionId })
  },
  sendInput(idOrName: string, data: string): Promise<unknown> {
    return cockpitInvoke('session.input', { idOrName, data })
  },
  resizeSession(idOrName: string, cols: number, rows: number): Promise<unknown> {
    return cockpitInvoke('session.resize', { idOrName, cols, rows })
  },
  stopSession(idOrName: string): Promise<unknown> {
    return cockpitInvoke('session.stop', { idOrName })
  },
  killSession(idOrName: string, removeWorktree?: boolean): Promise<unknown> {
    return cockpitInvoke('session.kill', { idOrName, removeWorktree })
  },
  convergeStatus(): Promise<unknown> {
    return cockpitInvoke('converge.status')
  },
  landSession(idOrName: string, force?: boolean): Promise<unknown> {
    return cockpitInvoke('land.session', { idOrName, force })
  },
  onSessionData(cb: (payload: unknown) => void): () => void {
    return cockpitListen('session.data', cb)
  },
  onTuiEvent(cb: (payload: unknown) => void): () => void {
    return cockpitListen('tui.event', cb)
  },
  onTuiInvalidate(cb: (payload: unknown) => void): () => void {
    return cockpitListen('tui.invalidate', cb)
  },
  onDaemonGone(cb: (payload: unknown) => void): () => void {
    return cockpitListen('daemon.gone', cb)
  },
}
