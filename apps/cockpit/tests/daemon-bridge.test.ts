import { describe, expect, test } from 'bun:test'
import { DaemonBridge, encodeSessionData, isForwardedNotification } from '../electron/daemon-bridge'
import type { CockpitEvent } from '../electron/channels'

class FakeDaemon {
  calls: Array<{ method: string; params: Record<string, unknown>; notificationsAtCall: number }> = []
  handlers: Array<(method: string, params: unknown) => void> = []
  closeHandlers: Array<() => void> = []
  closed = false
  responses: Record<string, unknown> = {
    'workspace.init': { id: 'ws_1', name: 'demo', rootPath: '/tmp/demo' },
    'daemon.subscribe': { subscribed: true },
    'session.list': [{ id: 's1', name: 'alpha' }],
    'session.attach': { ok: true, sessionId: 's1', name: 'alpha' },
  }

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params, notificationsAtCall: this.handlers.length })
    if (method in this.responses) return this.responses[method] as T
    return { ok: true } as T
  }

  onNotification(cb: (method: string, params: unknown) => void): void {
    this.handlers.push(cb)
  }

  onClose(cb: () => void): void {
    this.closeHandlers.push(cb)
  }

  close(): void {
    this.closed = true
  }

  emit(method: string, params: unknown): void {
    for (const h of this.handlers) h(method, params)
  }

  drop(): void {
    for (const h of this.closeHandlers) h()
  }
}

function makeBridge(overrides?: {
  fake?: FakeDaemon
  pickFolder?: () => Promise<string | undefined>
  saved?: string | undefined
  exists?: (path: string) => boolean
}) {
  const fake = overrides?.fake ?? new FakeDaemon()
  const events: Array<{ event: CockpitEvent; payload: unknown }> = []
  let saved = overrides?.saved
  const picked: string[] = []
  const bridge = new DaemonBridge({
    connect: async () => fake,
    pickFolder: overrides?.pickFolder ?? (async () => {
      picked.push('/tmp/picked')
      return '/tmp/picked'
    }),
    loadSavedRoot: () => saved,
    saveRoot: (root) => {
      saved = root
    },
    exists: overrides?.exists ?? (() => true),
    send: (event, payload) => {
      events.push({ event, payload })
    },
  })
  return { bridge, fake, events, picked, getSaved: () => saved }
}

describe('notification filter', () => {
  test('forwards session.data, tui.event, tui.invalidate only', () => {
    expect(isForwardedNotification('session.data')).toBe(true)
    expect(isForwardedNotification('tui.event')).toBe(true)
    expect(isForwardedNotification('tui.invalidate')).toBe(true)
    expect(isForwardedNotification('session.exit')).toBe(false)
    expect(isForwardedNotification('daemon.gone')).toBe(false)
    expect(isForwardedNotification('evil')).toBe(false)
  })

  test('session.data keeps string chunks and base64-encodes bytes', () => {
    expect(encodeSessionData({ sessionId: 's1', chunk: 'hello' })).toEqual({
      sessionId: 's1',
      chunk: 'hello',
    })
    expect(encodeSessionData({ sessionId: 's1', chunk: new Uint8Array([0, 1, 255]) })).toEqual({
      sessionId: 's1',
      chunk: Buffer.from([0, 1, 255]).toString('base64'),
      encoding: 'base64',
    })
  })
})

describe('DaemonBridge', () => {
  test('workspace.ensure picks a folder, connects, inits, then subscribes', async () => {
    const { bridge, fake, picked, getSaved } = makeBridge({ saved: undefined })
    const result = await bridge.handle('workspace.ensure')
    expect(picked).toEqual(['/tmp/picked'])
    expect(getSaved()).toBe('/tmp/picked')
    expect(fake.calls.map((c) => c.method)).toEqual(['workspace.init', 'daemon.subscribe'])
    const sub = fake.calls.find((c) => c.method === 'daemon.subscribe')
    expect(sub?.notificationsAtCall).toBeGreaterThan(0)
    expect(result).toEqual({
      projectRoot: '/tmp/picked',
      workspace: { id: 'ws_1', name: 'demo', rootPath: '/tmp/demo' },
    })
  })

  test('workspace.ensure skips the picker when a projectRoot is given', async () => {
    const { bridge, picked } = makeBridge({ saved: undefined })
    await bridge.handle('workspace.ensure', { projectRoot: '/tmp/given' })
    expect(picked).toEqual([])
  })

  test('workspace.ensure uses a saved root instead of picking', async () => {
    const { bridge, picked } = makeBridge({ saved: '/tmp/saved' })
    await bridge.handle('workspace.ensure')
    expect(picked).toEqual([])
  })

  test('session.list injects the ensured workspace id', async () => {
    const { bridge, fake } = makeBridge()
    await bridge.handle('workspace.ensure', { projectRoot: '/tmp/given' })
    const listed = await bridge.handle('session.list')
    expect(listed).toEqual([{ id: 's1', name: 'alpha' }])
    expect(fake.calls.at(-1)).toMatchObject({
      method: 'session.list',
      params: { workspaceId: 'ws_1' },
    })
  })

  test('session RPCs merge renderer payload with workspaceId', async () => {
    const { bridge, fake } = makeBridge()
    await bridge.handle('workspace.ensure', { projectRoot: '/tmp/given' })
    await bridge.handle('session.attach', { idOrName: 'alpha' })
    expect(fake.calls.at(-1)).toMatchObject({
      method: 'session.attach',
      params: { workspaceId: 'ws_1', idOrName: 'alpha' },
    })
  })

  test('session.detach does not call the daemon', async () => {
    const { bridge, fake } = makeBridge()
    await bridge.handle('workspace.ensure', { projectRoot: '/tmp/given' })
    fake.calls.length = 0
    const result = await bridge.handle('session.detach', { sessionId: 's1' })
    expect(result).toEqual({ ok: true })
    expect(fake.calls).toEqual([])
  })

  test('forwards daemon notifications and drops the rest', async () => {
    const { bridge, fake, events } = makeBridge()
    await bridge.handle('workspace.ensure', { projectRoot: '/tmp/given' })
    fake.emit('session.data', { sessionId: 's1', chunk: 'hi' })
    fake.emit('tui.event', { kind: 'blocked' })
    fake.emit('tui.invalidate', {})
    fake.emit('session.exit', { sessionId: 's1', code: 0 })
    expect(events).toEqual([
      { event: 'session.data', payload: { sessionId: 's1', chunk: 'hi' } },
      { event: 'tui.event', payload: { kind: 'blocked' } },
      { event: 'tui.invalidate', payload: {} },
    ])
  })

  test('emits daemon.gone when the client closes', async () => {
    const { bridge, fake, events } = makeBridge()
    await bridge.handle('workspace.ensure', { projectRoot: '/tmp/given' })
    fake.drop()
    expect(events).toEqual([{ event: 'daemon.gone', payload: {} }])
  })

  test('RPC channels other than list still go to the daemon', async () => {
    const { bridge, fake } = makeBridge()
    await bridge.handle('workspace.ensure', { projectRoot: '/tmp/given' })
    await bridge.handle('converge.status')
    await bridge.handle('land.session', { idOrName: 'alpha', force: false })
    await bridge.handle('session.new', { name: 'beta', agent: 'claude' })
    expect(fake.calls.filter((c) => c.method === 'converge.status')[0]?.params).toEqual({
      workspaceId: 'ws_1',
    })
    expect(fake.calls.filter((c) => c.method === 'land.session')[0]?.params).toEqual({
      workspaceId: 'ws_1',
      idOrName: 'alpha',
      force: false,
    })
    expect(fake.calls.filter((c) => c.method === 'session.new')[0]?.params).toEqual({
      workspaceId: 'ws_1',
      name: 'beta',
      agent: 'claude',
    })
  })

  test('rejects session.list before workspace.ensure', async () => {
    const { bridge } = makeBridge()
    await expect(bridge.handle('session.list')).rejects.toThrow(/workspace\.ensure/)
  })
})
