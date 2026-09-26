import { Buffer } from 'node:buffer'
import { isCockpitChannel, type CockpitChannel, type CockpitEvent } from './channels'

export type DaemonLike = {
  call<T>(method: string, params?: Record<string, unknown>): Promise<T>
  onNotification(cb: (method: string, params: unknown) => void): void
  onClose(cb: () => void): void
  close(): void
}

export type WorkspaceSnapshot = {
  id: string
  name: string
  rootPath: string
}

export type DaemonBridgeDeps = {
  connect: (projectRoot: string) => Promise<DaemonLike>
  pickFolder: () => Promise<string | undefined>
  loadSavedRoot: () => string | undefined
  saveRoot: (root: string) => void
  send: (event: CockpitEvent, payload: unknown) => void
  exists?: (path: string) => boolean
}

const FORWARDED = new Set<string>(['session.data', 'session.exit', 'tui.event', 'tui.invalidate', 'terminal.data', 'terminal.exit'])

export function isForwardedNotification(method: string): method is Exclude<CockpitEvent, 'daemon.gone'> {
  return FORWARDED.has(method)
}

export function encodeSessionData(params: unknown): { sessionId: string; chunk: string; encoding?: 'base64' } {
  const record = asRecord(params)
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId : ''
  const chunk = record.chunk
  if (typeof chunk === 'string') {
    return { sessionId, chunk }
  }
  if (chunk instanceof Uint8Array) {
    return { sessionId, chunk: Buffer.from(chunk).toString('base64'), encoding: 'base64' }
  }
  return { sessionId, chunk: '' }
}

/** terminal.data is session.data plus the terminal's own id, which panes filter on. */
export function encodeTerminalData(params: unknown): { terminalId: string; sessionId: string; chunk: string; encoding?: 'base64' } {
  const record = asRecord(params)
  const terminalId = typeof record.terminalId === 'string' ? record.terminalId : ''
  return { terminalId, ...encodeSessionData(params) }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function hasProjectRoot(payload: unknown): boolean {
  return typeof (payload as { projectRoot?: unknown } | null | undefined)?.projectRoot === 'string'
}

export class DaemonBridge {
  private client: DaemonLike | undefined
  private workspace: WorkspaceSnapshot | undefined
  private projectRoot: string | undefined
  /** Serializes ensure so main+renderer cannot race the folder picker / double-connect. */
  private ensureTail: Promise<void> = Promise.resolve()
  /** The ensure in flight, which a root-less ensure joins instead of queueing behind. */
  private ensuring: Promise<{ projectRoot: string; workspace: WorkspaceSnapshot }> | undefined

  constructor(private readonly deps: DaemonBridgeDeps) {}

  async handle(channel: string, payload?: unknown): Promise<unknown> {
    if (!isCockpitChannel(channel)) {
      throw new Error(`Disallowed invoke channel: ${channel}`)
    }
    if (channel === 'workspace.ensure') {
      // "The current workspace" while one is being attached IS that attach: queueing
      // behind it doubled the wait before a dead daemon was reported, and spawned a
      // second daemon to find out.
      if (this.ensuring !== undefined && !hasProjectRoot(payload)) return this.ensuring
      const run = this.ensureTail.then(() => this.ensure(payload))
      this.ensuring = run
      const settle = (): void => {
        if (this.ensuring === run) this.ensuring = undefined
      }
      this.ensureTail = run.then(settle, settle)
      return run
    }
    // The window exists before main's first ensure finishes; a call made in that gap
    // waits for it rather than failing "not attached".
    if (this.ensuring !== undefined) await this.ensuring.catch(() => undefined)
    if (!this.client || !this.workspace) {
      throw new Error('Workspace is not attached; invoke workspace.ensure first')
    }
    if (channel === 'session.detach') {
      return { ok: true }
    }
    return this.rpc(channel, payload)
  }

  close(): void {
    const client = this.client
    this.detach(client)
    client?.close()
  }

  private detach(client: DaemonLike | undefined): void {
    if (this.client !== client) return
    this.client = undefined
    this.workspace = undefined
    this.projectRoot = undefined
  }

  private async ensure(payload: unknown): Promise<{ projectRoot: string; workspace: WorkspaceSnapshot }> {
    const projectRoot = await this.resolveProjectRoot(payload)
    if (this.client && this.workspace && this.projectRoot === projectRoot) {
      return { projectRoot, workspace: this.workspace }
    }

    const previous = this.client
    const client = await this.deps.connect(projectRoot)

    client.onNotification((method, params) => {
      if (this.client !== client) return
      this.forward(method, params)
    })
    client.onClose(() => {
      if (this.client !== client) return
      this.detach(client)
      this.deps.send('daemon.gone', {})
    })

    try {
      const workspace = await client.call<WorkspaceSnapshot>('workspace.init', {})
      await client.call('daemon.subscribe', {})
      // E2E hint: let DaemonClient decrypt session.data for this workspace
      try {
        const maybe = client as unknown as { setProjectRoot?: (r: string) => void; setWorkspaceRoot?: (id: string, r: string) => void };
        if (maybe.setProjectRoot) maybe.setProjectRoot(projectRoot);
        if (maybe.setWorkspaceRoot) maybe.setWorkspaceRoot(workspace.id, projectRoot);
      } catch {}
      this.client = client
      this.projectRoot = projectRoot
      this.workspace = workspace
      this.deps.saveRoot(projectRoot)
      previous?.close()
      return { projectRoot, workspace }
    } catch (err) {
      client.close()
      throw err
    }
  }

  private async resolveProjectRoot(payload: unknown): Promise<string> {
    const given = asRecord(payload).projectRoot
    if (typeof given === 'string' && given.length > 0) {
      return given
    }
    const saved = this.deps.loadSavedRoot()
    const exists = this.deps.exists ?? (() => true)
    if (typeof saved === 'string' && saved.length > 0 && exists(saved)) {
      return saved
    }
    const picked = await this.deps.pickFolder()
    if (!picked) {
      throw new Error('No project folder selected')
    }
    return picked
  }

  private async rpc(channel: CockpitChannel, payload: unknown): Promise<unknown> {
    const client = this.client
    const workspace = this.workspace
    if (!client || !workspace) {
      throw new Error('Workspace is not attached; invoke workspace.ensure first')
    }
    const params = { ...asRecord(payload), workspaceId: workspace.id }
    return client.call(channel, params)
  }

  private forward(method: string, params: unknown): void {
    if (!isForwardedNotification(method)) return
    const payload = method === 'session.data'
      ? encodeSessionData(params)
      : method === 'terminal.data' ? encodeTerminalData(params) : (params ?? {})
    this.deps.send(method, payload)
  }
}