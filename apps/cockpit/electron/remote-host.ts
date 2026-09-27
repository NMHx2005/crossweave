import type { RemoteSettings } from '../../../src/core/settings.js'
import type { Device } from '../../../src/remote/devices.js'

/**
 * Remote access from a phone, as the cockpit runs it: a `cwd remote` child process
 * (src/remote/main.ts) while Settings → Remote is on, driven over its stdin and heard on
 * its stdout. The child dies with the app — killed on quit, and it exits by itself when
 * its stdin closes — so nothing listens for phones once the cockpit is gone.
 *
 * The renderer only ever sees `RemoteState`, pushed whole on every change.
 */

export type RemoteLink = { reach: 'tailscale' | 'wifi'; url: string; qr: boolean[][] }

export type RemoteState = {
  enabled: boolean
  listening: Array<{ reach: 'tailscale' | 'wifi'; url: string }>
  problems: string[]
  caFingerprint?: string
  /** Phones connected right now. */
  peers: Array<{ id: string; name: string }>
  devices: Device[]
  /** The live pairing code, while one is shown. */
  pair?: { code: string; display: string; expiresAt: number; links: RemoteLink[] }
  /** The phone that paired last, so the pairing dialog can say so. */
  paired?: { id: string; name: string; at: number }
  /** What this Mac offers, for the form: its Tailscale address and Wi-Fi addresses. */
  addresses: { tailscale?: string; wifi: Array<{ address: string; interface: string }> }
}

export interface RemoteChild {
  write(line: string): void
  onLine(cb: (line: string) => void): void
  onExit(cb: (code: number | null) => void): void
  kill(): void
}

export type RemoteHostDeps = {
  spawn: () => RemoteChild
  settings: () => RemoteSettings | undefined
  projects: () => Array<{ root: string; name: string }>
  devices: () => Device[]
  removeDevice: (id: string) => boolean
  addresses: () => RemoteState['addresses']
  push: (state: RemoteState) => void
  now?: () => number
  /** A crashed child is restarted after this long, at most `maxRestarts` times a minute. */
  restartDelayMs?: number
}

const MAX_RESTARTS_PER_MINUTE = 3

export class RemoteHost {
  private child: RemoteChild | undefined
  private state: RemoteState
  private restarts: number[] = []

  constructor(private readonly deps: RemoteHostDeps) {
    this.state = { enabled: false, listening: [], problems: [], peers: [], devices: deps.devices(), addresses: deps.addresses() }
  }

  private get now(): number {
    return (this.deps.now ?? Date.now)()
  }

  snapshot(): RemoteState {
    // Devices and addresses are read fresh: `cw remote revoke` or a Wi-Fi change can
    // happen while the window is open.
    this.state = { ...this.state, devices: this.deps.devices(), addresses: this.deps.addresses() }
    return this.state
  }

  private update(patch: Partial<RemoteState>): void {
    this.state = { ...this.state, ...patch }
    this.deps.push(this.snapshot())
  }

  /** Settings were saved (or the app started): run the child or not, and tell it to re-plan. */
  apply(): void {
    const enabled = this.deps.settings()?.enabled === true
    if (!enabled) {
      this.stop()
      this.update({ enabled: false, listening: [], problems: [], peers: [], pair: undefined })
      return
    }
    if (this.child === undefined) this.start()
    else this.send({ type: 'reload' })
    this.update({ enabled: true })
  }

  /** The window's open projects changed. */
  projectsChanged(): void {
    this.send({ type: 'projects', projects: this.deps.projects() })
  }

  pair(): { ok: boolean; reason?: string } {
    if (this.child === undefined) return { ok: false, reason: 'Turn on remote access and Save first' }
    if (this.state.listening.length === 0) return { ok: false, reason: 'Remote access is not listening anywhere yet' }
    this.send({ type: 'pair' })
    return { ok: true }
  }

  cancelPair(): void {
    this.send({ type: 'pair.cancel' })
    this.update({ pair: undefined })
  }

  /** Removed from the file; a running server notices within seconds and drops the phone. */
  revoke(id: unknown): { ok: boolean } {
    if (typeof id !== 'string') return { ok: false }
    const ok = this.deps.removeDevice(id)
    this.update({})
    return { ok }
  }

  stop(): void {
    const child = this.child
    this.child = undefined
    // Forgotten before the kill: its exit is then no crash to restart from.
    if (child !== undefined) child.kill()
  }

  private send(msg: unknown): void {
    this.child?.write(`${JSON.stringify(msg)}\n`)
  }

  private start(): void {
    const child = this.deps.spawn()
    this.child = child
    child.onLine((line) => this.hear(line))
    child.onExit(() => {
      if (this.child !== child) return
      this.child = undefined
      if (this.deps.settings()?.enabled !== true) return
      // Crashed while on: try again, but not in a loop.
      const now = this.now
      this.restarts = this.restarts.filter((t) => now - t < 60_000)
      if (this.restarts.length >= MAX_RESTARTS_PER_MINUTE) {
        this.update({ listening: [], peers: [], problems: ['Remote access stopped unexpectedly — turn it off and on again in Settings'] })
        return
      }
      this.restarts.push(now)
      this.update({ listening: [], peers: [] })
      setTimeout(() => { if (this.child === undefined && this.deps.settings()?.enabled === true) this.apply() }, this.deps.restartDelayMs ?? 1000)
    })
    this.send({ type: 'projects', projects: this.deps.projects() })
  }

  private hear(line: string): void {
    let e: { type?: unknown; [k: string]: unknown }
    try {
      e = JSON.parse(line)
    } catch {
      return
    }
    switch (e.type) {
      case 'status':
        this.update({
          listening: Array.isArray(e.listening) ? e.listening as RemoteState['listening'] : [],
          problems: Array.isArray(e.problems) ? (e.problems as unknown[]).filter((p): p is string => typeof p === 'string') : [],
          ...(typeof e.caFingerprint === 'string' ? { caFingerprint: e.caFingerprint } : {}),
        })
        break
      case 'pair':
        if (typeof e.code === 'string' && typeof e.display === 'string' && typeof e.expiresAt === 'number' && Array.isArray(e.links)) {
          this.update({ pair: { code: e.code, display: e.display, expiresAt: e.expiresAt, links: e.links as RemoteLink[] } })
        }
        break
      case 'paired': {
        const d = e.device as { id?: unknown; name?: unknown } | undefined
        if (typeof d?.id === 'string' && typeof d.name === 'string') {
          this.update({ pair: undefined, paired: { id: d.id, name: d.name, at: this.now } })
        }
        break
      }
      case 'peers':
        if (Array.isArray(e.devices)) this.update({ peers: e.devices as RemoteState['peers'] })
        break
      case 'error':
        if (typeof e.message === 'string') this.update({ problems: [...this.state.problems.filter((p) => p !== e.message), e.message] })
        break
    }
  }
}
