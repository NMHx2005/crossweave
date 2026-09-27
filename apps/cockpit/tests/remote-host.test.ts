import { describe, expect, test } from 'bun:test'
import { RemoteHost, type RemoteChild, type RemoteState } from '../electron/remote-host'
import type { RemoteSettings } from '../../../src/core/settings.js'

class FakeChild implements RemoteChild {
  written: unknown[] = []
  killed = false
  private lines: Array<(l: string) => void> = []
  private exits: Array<(c: number | null) => void> = []
  write(line: string): void { this.written.push(JSON.parse(line)) }
  onLine(cb: (l: string) => void): void { this.lines.push(cb) }
  onExit(cb: (c: number | null) => void): void { this.exits.push(cb) }
  kill(): void { this.killed = true; this.exit(null) }
  say(event: unknown): void { for (const l of this.lines) l(JSON.stringify(event)) }
  exit(code: number | null): void { for (const e of this.exits) e(code) }
}

function setup(initial: RemoteSettings | undefined = { enabled: true, tailscale: true }) {
  let settings = initial
  const children: FakeChild[] = []
  const pushed: RemoteState[] = []
  const devices = [{ id: 'd1', name: 'iPhone', createdAt: '2026-09-27T00:00:00Z', lastSeenAt: null }]
  let t = 0
  const host = new RemoteHost({
    spawn: () => { const c = new FakeChild(); children.push(c); return c },
    settings: () => settings,
    projects: () => [{ root: '/repo/a', name: 'a' }],
    devices: () => [...devices],
    removeDevice: (id) => { const i = devices.findIndex((d) => d.id === id); if (i < 0) return false; devices.splice(i, 1); return true },
    addresses: () => ({ tailscale: '100.101.2.3', wifi: [{ address: '192.168.1.20', interface: 'en0' }] }),
    push: (s) => pushed.push(s),
    now: () => t,
    restartDelayMs: 1,
  })
  return { host, children, pushed, set: (s: RemoteSettings | undefined) => { settings = s }, tick: (ms: number) => { t += ms } }
}

const wait = () => new Promise((r) => setTimeout(r, 10))

describe('remote host', () => {
  test('runs nothing while off', () => {
    const { host, children, pushed } = setup({ enabled: false })
    host.apply()
    expect(children).toHaveLength(0)
    expect(pushed.at(-1)).toMatchObject({ enabled: false, listening: [] })
  })

  test('starts the child with the open projects, and re-plans on the next apply', () => {
    const { host, children } = setup()
    host.apply()
    expect(children).toHaveLength(1)
    expect(children[0]?.written[0]).toEqual({ type: 'projects', projects: [{ root: '/repo/a', name: 'a' }] })
    host.apply()
    expect(children).toHaveLength(1)
    expect(children[0]?.written.at(-1)).toEqual({ type: 'reload' })
  })

  test('kills the child when turned off, without restarting it', async () => {
    const { host, children, set, pushed } = setup()
    host.apply()
    set({ enabled: false })
    host.apply()
    await wait()
    expect(children[0]?.killed).toBe(true)
    expect(children).toHaveLength(1)
    expect(pushed.at(-1)).toMatchObject({ enabled: false, peers: [] })
  })

  test('passes the child\'s status, pairing and peers on as one state', () => {
    const { host, children, pushed } = setup()
    host.apply()
    const c = children[0] as FakeChild
    c.say({ type: 'status', listening: [{ reach: 'tailscale', url: 'http://100.101.2.3:7788/' }], problems: [] })
    expect(host.pair()).toEqual({ ok: true })
    expect(c.written.at(-1)).toEqual({ type: 'pair' })
    c.say({ type: 'pair', code: 'ABCDEFGHJK', display: 'ABCDE-FGHJK', expiresAt: 5, links: [{ reach: 'tailscale', url: 'u', qr: [[true]] }] })
    expect(pushed.at(-1)?.pair?.display).toBe('ABCDE-FGHJK')
    c.say({ type: 'paired', device: { id: 'd2', name: 'Pixel' } })
    expect(pushed.at(-1)?.pair).toBeUndefined()
    expect(pushed.at(-1)?.paired).toMatchObject({ name: 'Pixel' })
    c.say({ type: 'peers', devices: [{ id: 'd2', name: 'Pixel' }] })
    expect(pushed.at(-1)?.peers).toEqual([{ id: 'd2', name: 'Pixel' }])
    c.say('not json')
  })

  test('will not pair before it listens somewhere', () => {
    const { host } = setup({ enabled: false })
    expect(host.pair().ok).toBe(false)
    const on = setup()
    on.host.apply()
    expect(on.host.pair().ok).toBe(false)
  })

  test('tells the child about project changes', () => {
    const { host, children } = setup()
    host.apply()
    host.projectsChanged()
    expect(children[0]?.written.at(-1)).toMatchObject({ type: 'projects' })
  })

  test('removes a device and shows the list without it', () => {
    const { host, pushed } = setup()
    expect(host.revoke('d1')).toEqual({ ok: true })
    expect(pushed.at(-1)?.devices).toEqual([])
    expect(host.revoke(42)).toEqual({ ok: false })
  })

  test('restarts a crashed child, but gives up after three crashes a minute', async () => {
    const { host, children, pushed } = setup()
    host.apply()
    for (let i = 0; i < 3; i++) {
      children.at(-1)?.exit(1)
      await wait()
    }
    expect(children).toHaveLength(4)
    children.at(-1)?.exit(1)
    await wait()
    expect(children).toHaveLength(4)
    expect(pushed.at(-1)?.problems[0]).toMatch(/stopped unexpectedly/)
  })
})
