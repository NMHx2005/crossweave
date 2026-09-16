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

const FORWARDED = new Set<string>(['session.data', 'tui.event', 'tui.invalidate'])

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

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

export class DaemonBridge {
  private client: DaemonLike | undefined
  private workspace: WorkspaceSnapshot | undefined
  private projectRoot: string | undefined

  constructor(private readonly deps: DaemonBridgeDeps) {}

  async handle(channel: string, payload?: unknown): Promise<unknown> {
    if (!isCockpitChannel(channel)) {
      throw new Error(`Disallowed invoke channel: ${channel}`)
    }
    if (channel === 'workspace.ensure') {
      return this.ensure(payload)
    }
    if (!this.client || !this.workspace) {
      throw new Error('Workspace is not attached; invoke workspace.ensure first')
    }
    if (channel === 'session.detach') {
      return { ok: true }
    }
    return this.rpc(channel, payload)
  }

  close(): void {
    this.client?.close()
    this.client = undefined
    this.workspace = undefined
    this.projectRoot = undefined
  }

  private async ensure(payload: unknown): Promise<{ projectRoot: string; workspace: WorkspaceSnapshot }> {
    const projectRoot = await this.resolveProjectRoot(payload)
    if (this.client && this.workspace && this.projectRoot === projectRoot) {
      return { projectRoot, workspace: this.workspace }
    }

    this.client?.close()
    const client = await this.deps.connect(projectRoot)
    this.client = client
    this.projectRoot = projectRoot
    this.deps.saveRoot(projectRoot)

    client.onNotification((method, params) => {
      this.forward(method, params)
    })
    client.onClose(() => {
      this.deps.send('daemon.gone', {})
    })

    const workspace = await client.call<WorkspaceSnapshot>('workspace.init', {})
    this.workspace = workspace
    await client.call('daemon.subscribe', {})
    return { projectRoot, workspace }
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
    const payload = method === 'session.data' ? encodeSessionData(params) : (params ?? {})
    this.deps.send(method, payload)
  }
}