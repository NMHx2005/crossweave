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
  /** The active project was closed: the next launch opens on the welcome, not on it. */
  forgetSavedRoot?: () => void
  send: (event: CockpitEvent, payload: unknown) => void
  exists?: (path: string) => boolean
  /** The projects this window lists in its rail, in the order they were opened. */
  loadOpenRoots?: () => string[]
  saveOpenRoots?: (roots: string[]) => void
}

type Attached = { client: DaemonLike; workspace: WorkspaceSnapshot }

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

/**
 * The renderer's one way to the daemons. One project is ACTIVE — its tabs are on the
 * stage and every channel targets it — but a window keeps a connection to each project
 * it has open, so the rail can list them all: switching projects used to close the
 * previous connection, and a window could only ever know one repository.
 */
export class DaemonBridge {
  private client: DaemonLike | undefined
  private workspace: WorkspaceSnapshot | undefined
  private projectRoot: string | undefined
  /** Every attached project, the active one included. */
  private readonly pool = new Map<string, Attached>()
  /** Connections being opened, so two callers never start two for one project. */
  private readonly connecting = new Map<string, Promise<Attached>>()
  private openRootsFallback: string[] = []
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
    // The welcome (no project attached yet) still lists and picks projects.
    if (channel === 'projects.list') return { active: this.projectRoot, open: this.openRoots() }
    if (channel === 'projects.pick') return { projectRoot: (await this.deps.pickFolder()) ?? null }
    // The window exists before main's first ensure finishes; a call made in that gap
    // waits for it rather than failing "not attached".
    if (this.ensuring !== undefined) await this.ensuring.catch(() => undefined)
    if (!this.client || !this.workspace) {
      throw new Error('Workspace is not attached; invoke workspace.ensure first')
    }
    if (channel === 'session.detach') {
      return { ok: true }
    }
    if (channel === 'projects.sessions') return this.projectSessions(payload)
    if (channel === 'projects.close') return this.closeProject(payload)
    if (channel === 'projects.reorder') return this.reorder(payload)
    return this.rpc(channel, payload)
  }

  private openRoots(): string[] {
    const exists = this.deps.exists ?? (() => true)
    return (this.deps.loadOpenRoots?.() ?? this.openRootsFallback).filter((root) => exists(root))
  }

  private rememberOpen(root: string): void {
    const current = this.deps.loadOpenRoots?.() ?? this.openRootsFallback
    if (current.includes(root)) return
    const next = [...current, root]
    if (this.deps.saveOpenRoots) this.deps.saveOpenRoots(next)
    else this.openRootsFallback = next
  }

  private rootOf(payload: unknown): string {
    const root = asRecord(payload).projectRoot
    if (typeof root !== 'string' || root.length === 0) throw new Error('projectRoot is required')
    return root
  }

  /** A project's sessions and land verdicts, for the rail — attaching it if need be. */
  private async projectSessions(payload: unknown): Promise<unknown> {
    const projectRoot = this.rootOf(payload)
    const { client, workspace } = await this.attach(projectRoot)
    const params = { workspaceId: workspace.id }
    const sessions = await client.call('session.list', params)
    const converge = await client.call('converge.status', params).catch(() => undefined)
    return { projectRoot, name: workspace.name, sessions, converge }
  }

  /**
   * Closing the active project detaches the window from it too; the renderer then
   * switches to another open project, or shows the welcome when none is left.
   */
  private closeProject(payload: unknown): { ok: true } {
    const projectRoot = this.rootOf(payload)
    if (projectRoot === this.projectRoot) {
      this.detach(this.client)
      this.deps.forgetSavedRoot?.()
    }
    const next = (this.deps.loadOpenRoots?.() ?? this.openRootsFallback).filter((r) => r !== projectRoot)
    if (this.deps.saveOpenRoots) this.deps.saveOpenRoots(next)
    else this.openRootsFallback = next
    const attached = this.pool.get(projectRoot)
    this.pool.delete(projectRoot)
    attached?.client.close()
    return { ok: true }
  }

  /** The rail's order, as the user arranged it: the same projects, nothing added or dropped. */
  private reorder(payload: unknown): { ok: true } {
    const roots = asRecord(payload).roots
    const current = this.deps.loadOpenRoots?.() ?? this.openRootsFallback
    if (!Array.isArray(roots) || roots.length !== current.length || new Set(roots).size !== roots.length
      || !roots.every((r) => typeof r === 'string' && current.includes(r))) {
      throw new Error('roots must be the open projects, reordered')
    }
    if (this.deps.saveOpenRoots) this.deps.saveOpenRoots(roots as string[])
    else this.openRootsFallback = roots as string[]
    return { ok: true }
  }

  /**
   * A connection to `projectRoot`'s daemon, opened once and kept. Notifications from
   * it reach the renderer only while it is the active project; otherwise its changes
   * are announced as `project.invalidate`, and its output — which no pane shows —
   * goes nowhere.
   */
  private attach(projectRoot: string): Promise<Attached> {
    const existing = this.pool.get(projectRoot)
    if (existing !== undefined) return Promise.resolve(existing)
    const pending = this.connecting.get(projectRoot)
    if (pending !== undefined) return pending
    const run = (async (): Promise<Attached> => {
      const client = await this.deps.connect(projectRoot)
      // Every open project speaks, not only the one on the stage: each keeps its panes
      // alive in the window, so its output must keep arriving while another is shown.
      client.onNotification((method, params) => {
        if (this.pool.get(projectRoot)?.client !== client) return
        this.forward(method, params, projectRoot)
      })
      client.onClose(() => {
        if (this.pool.get(projectRoot)?.client !== client) return
        this.pool.delete(projectRoot)
        if (this.client === client) this.detach(client)
        this.deps.send('daemon.gone', { projectRoot })
      })
      try {
        const workspace = await client.call<WorkspaceSnapshot>('workspace.init', {})
        await client.call('daemon.subscribe', {})
        // E2E hint: let DaemonClient decrypt session.data for this workspace
        try {
          const maybe = client as unknown as { setProjectRoot?: (r: string) => void; setWorkspaceRoot?: (id: string, r: string) => void }
          if (maybe.setProjectRoot) maybe.setProjectRoot(projectRoot)
          if (maybe.setWorkspaceRoot) maybe.setWorkspaceRoot(workspace.id, projectRoot)
        } catch {}
        const attached = { client, workspace }
        this.pool.set(projectRoot, attached)
        this.rememberOpen(projectRoot)
        return attached
      } catch (err) {
        client.close()
        throw err
      }
    })()
    this.connecting.set(projectRoot, run)
    const settle = (): void => { this.connecting.delete(projectRoot) }
    run.then(settle, settle)
    return run
  }

  close(): void {
    this.detach(this.client)
    for (const { client } of this.pool.values()) client.close()
    this.pool.clear()
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
    const { client, workspace } = await this.attach(projectRoot)
    this.client = client
    this.projectRoot = projectRoot
    this.workspace = workspace
    this.deps.saveRoot(projectRoot)
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
    // No dialog here: an app opened from the Dock with no project yet shows its
    // welcome, where the user picks one (projects.pick) when they choose to.
    throw new Error('NO_PROJECT: open a project to begin')
  }

  private async rpc(channel: CockpitChannel, payload: unknown): Promise<unknown> {
    const { projectRoot: target, ...rest } = asRecord(payload)
    let client = this.client
    let workspace = this.workspace
    // A project's view names its project on every call; the active one is only the
    // default for calls that do not. Only projects open in this window are reachable.
    if (typeof target === 'string' && target !== this.projectRoot) {
      if (!this.openRoots().includes(target)) throw new Error('That project is not open in this window')
      ;({ client, workspace } = await this.attach(target))
    }
    payload = rest
    if (!client || !workspace) {
      throw new Error('Workspace is not attached; invoke workspace.ensure first')
    }
    // workspace.gc names its workspace as `id`; it is always the attached one, never
    // whatever the renderer passed.
    const params = {
      ...asRecord(payload),
      workspaceId: workspace.id,
      ...(channel === 'workspace.gc' ? { id: workspace.id } : {}),
    }
    return client.call(channel, params)
  }

  private forward(method: string, params: unknown, projectRoot: string): void {
    if (!isForwardedNotification(method)) return
    const payload = method === 'session.data'
      ? encodeSessionData(params)
      : method === 'terminal.data' ? encodeTerminalData(params) : asRecord(params)
    this.deps.send(method, { ...payload, projectRoot })
  }
}