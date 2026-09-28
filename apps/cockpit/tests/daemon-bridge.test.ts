import { describe, expect, test } from 'bun:test'
import { DaemonBridge, encodeSessionData, isForwardedNotification } from '../electron/daemon-bridge'
import type { CockpitEvent } from '../electron/channels'

class FakeDaemon {
  calls: Array<{ method: string; params: Record<string, unknown>; notificationsAtCall: number }> = []
  handlers: Array<(method: string, params: unknown) => void> = []
  closeHandlers: Array<() => void> = []
  closed = false
  failMethod: string | undefined
  responses: Record<string, unknown> = {
    'workspace.init': { id: 'ws_1', name: 'demo', rootPath: '/tmp/demo' },
    'daemon.subscribe': { subscribed: true },
    'session.list': [{ id: 's1', name: 'alpha' }],
    'session.attach': { ok: true, sessionId: 's1', name: 'alpha' },
  }

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params, notificationsAtCall: this.handlers.length })
    if (this.failMethod === method) throw new Error(`${method} failed`)
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
  connect?: () => Promise<FakeDaemon>
  pickFolder?: () => Promise<string | undefined>
  saved?: string | undefined
  exists?: (path: string) => boolean
}) {
  const fake = overrides?.fake ?? new FakeDaemon()
  const events: Array<{ event: CockpitEvent; payload: unknown }> = []
  let saved = overrides?.saved
  const picked: string[] = []
  const connect = overrides?.connect ?? (async () => fake)
  const bridge = new DaemonBridge({
    connect,
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
  test('forwards session, terminal and tui notifications only', () => {
    expect(isForwardedNotification('session.data')).toBe(true)
    expect(isForwardedNotification('session.exit')).toBe(true)
    expect(isForwardedNotification('tui.event')).toBe(true)
    expect(isForwardedNotification('tui.invalidate')).toBe(true)
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
  test('workspace.ensure connects, inits, then subscribes, and remembers the root', async () => {
    const { bridge, fake, picked, getSaved } = makeBridge({ saved: undefined })
    const result = await bridge.handle('workspace.ensure', { projectRoot: '/tmp/given' })
    expect(picked).toEqual([])
    expect(getSaved()).toBe('/tmp/given')
    expect(fake.calls.map((c) => c.method)).toEqual(['workspace.init', 'daemon.subscribe'])
    const sub = fake.calls.find((c) => c.method === 'daemon.subscribe')
    expect(sub?.notificationsAtCall).toBeGreaterThan(0)
    expect(result).toEqual({
      projectRoot: '/tmp/given',
      workspace: { id: 'ws_1', name: 'demo', rootPath: '/tmp/demo' },
    })
  })

  // Opened from the Dock with no project yet, the app shows its welcome; a folder
  // dialog popping up on launch was the only way in before.
  test('with no project given or saved, ensure says so instead of opening a picker', async () => {
    const { bridge, picked } = makeBridge({ saved: undefined })
    await expect(bridge.handle('workspace.ensure')).rejects.toThrow(/NO_PROJECT/)
    expect(picked).toEqual([])
    // What the welcome needs works before any project is attached.
    expect(await bridge.handle('projects.list')).toEqual({ active: undefined, open: [], plain: [] })
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
    await bridge.handle('session.resume', { idOrName: 'alpha' })
    expect(fake.calls.at(-1)).toMatchObject({
      method: 'session.resume',
      params: { workspaceId: 'ws_1', idOrName: 'alpha' },
    })
    await bridge.handle('session.start', { idOrName: 'alpha' })
    expect(fake.calls.at(-1)).toMatchObject({
      method: 'session.start',
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

  // Every payload says which project it came from: several projects' views listen.
  test('forwards daemon notifications, tagged with their project, and drops the rest', async () => {
    const { bridge, fake, events } = makeBridge()
    await bridge.handle('workspace.ensure', { projectRoot: '/tmp/given' })
    fake.emit('session.data', { sessionId: 's1', chunk: 'hi' })
    fake.emit('tui.event', { kind: 'blocked' })
    fake.emit('tui.invalidate', {})
    fake.emit('session.exit', { sessionId: 's1', code: 0 })
    fake.emit('evil', {})
    const p = '/tmp/given'
    expect(events).toEqual([
      { event: 'session.data', payload: { sessionId: 's1', chunk: 'hi', projectRoot: p } },
      { event: 'tui.event', payload: { kind: 'blocked', projectRoot: p } },
      { event: 'tui.invalidate', payload: { projectRoot: p } },
      // Forwarded, so a pane can say the agent ended rather than going silently blank
      // when the terminal restores its (empty) primary buffer.
      { event: 'session.exit', payload: { sessionId: 's1', code: 0, projectRoot: p } },
    ])
  })

  test('emits daemon.gone, with its project, when the client closes', async () => {
    const { bridge, fake, events } = makeBridge()
    await bridge.handle('workspace.ensure', { projectRoot: '/tmp/given' })
    fake.drop()
    expect(events).toEqual([{ event: 'daemon.gone', payload: { projectRoot: '/tmp/given' } }])
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

  test('workspace.ensure reconnects after daemon.gone', async () => {
    const first = new FakeDaemon()
    const second = new FakeDaemon()
    second.responses['workspace.init'] = { id: 'ws_2', name: 'demo', rootPath: '/tmp/demo' }
    const fakes = [first, second]
    let connects = 0
    const { bridge, events } = makeBridge({
      connect: async () => {
        const next = fakes[connects]
        if (!next) throw new Error('no more fakes')
        connects += 1
        return next
      },
    })

    await bridge.handle('workspace.ensure', { projectRoot: '/tmp/given' })
    first.drop()
    expect(events).toEqual([{ event: 'daemon.gone', payload: { projectRoot: '/tmp/given' } }])
    await expect(bridge.handle('session.list')).rejects.toThrow(/workspace\.ensure/)

    const result = await bridge.handle('workspace.ensure', { projectRoot: '/tmp/given' })
    expect(connects).toBe(2)
    expect(result).toEqual({
      projectRoot: '/tmp/given',
      workspace: { id: 'ws_2', name: 'demo', rootPath: '/tmp/demo' },
    })
    await expect(bridge.handle('session.list')).resolves.toEqual([{ id: 's1', name: 'alpha' }])
  })

  test('stale client close after reconnect does not emit daemon.gone', async () => {
    const first = new FakeDaemon()
    const second = new FakeDaemon()
    const fakes = [first, second]
    let connects = 0
    const { bridge, events } = makeBridge({
      connect: async () => {
        const next = fakes[connects]
        if (!next) throw new Error('no more fakes')
        connects += 1
        return next
      },
    })

    await bridge.handle('workspace.ensure', { projectRoot: '/tmp/given' })
    first.drop()
    await bridge.handle('workspace.ensure', { projectRoot: '/tmp/given' })
    events.length = 0

    first.drop()
    expect(events).toEqual([])
    second.drop()
    expect(events).toEqual([{ event: 'daemon.gone', payload: { projectRoot: '/tmp/given' } }])
  })

  test('concurrent workspace.ensure shares one connect', async () => {
    let connects = 0
    let picks = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fake = new FakeDaemon()
    const { bridge } = makeBridge({
      saved: '/tmp/saved',
      fake,
      connect: async () => {
        connects += 1
        await gate
        return fake
      },
      pickFolder: async () => {
        picks += 1
        return '/tmp/picked'
      },
    })

    const first = bridge.handle('workspace.ensure')
    const second = bridge.handle('workspace.ensure')
    release()
    const [a, b] = await Promise.all([first, second])
    expect(connects).toBe(1)
    expect(picks).toBe(0)
    expect(a).toEqual(b)
    expect(a).toEqual({
      projectRoot: '/tmp/saved',
      workspace: { id: 'ws_1', name: 'demo', rootPath: '/tmp/demo' },
    })
  })

  test('failed workspace switch keeps the existing workspace operational', async () => {
    const first = new FakeDaemon()
    const second = new FakeDaemon()
    second.failMethod = 'daemon.subscribe'
    const fakes = [first, second]
    let connects = 0
    const { bridge } = makeBridge({
      connect: async () => {
        const next = fakes[connects]
        if (!next) throw new Error('no more fakes')
        connects += 1
        return next
      },
    })

    await bridge.handle('workspace.ensure', { projectRoot: '/tmp/first' })
    await expect(bridge.handle('workspace.ensure', { projectRoot: '/tmp/second' })).rejects.toThrow(
      /daemon\.subscribe failed/,
    )

    expect(first.closed).toBe(false)
    await expect(bridge.handle('session.list')).resolves.toEqual([{ id: 's1', name: 'alpha' }])
  })

  test('failed daemon.subscribe does not stick a half-attached workspace', async () => {
    const first = new FakeDaemon()
    first.failMethod = 'daemon.subscribe'
    const second = new FakeDaemon()
    const fakes = [first, second]
    let connects = 0
    const { bridge } = makeBridge({
      connect: async () => {
        const next = fakes[connects]
        if (!next) throw new Error('no more fakes')
        connects += 1
        return next
      },
    })

    await expect(bridge.handle('workspace.ensure', { projectRoot: '/tmp/given' })).rejects.toThrow(
      /daemon\.subscribe failed/,
    )
    await expect(bridge.handle('session.list')).rejects.toThrow(/workspace\.ensure/)

    const result = await bridge.handle('workspace.ensure', { projectRoot: '/tmp/given' })
    expect(connects).toBe(2)
    expect(result).toMatchObject({ workspace: { id: 'ws_1' } })
    expect(second.calls.map((c) => c.method)).toEqual(['workspace.init', 'daemon.subscribe'])
    await expect(bridge.handle('session.list')).resolves.toEqual([{ id: 's1', name: 'alpha' }])
  })
})

describe('terminal notifications', () => {
  test('forwards terminal.data with its terminal id and the chunk encoded like session.data', async () => {
    const { encodeTerminalData, isForwardedNotification } = await import('../electron/daemon-bridge')
    expect(isForwardedNotification('terminal.data')).toBe(true)
    expect(isForwardedNotification('terminal.exit')).toBe(true)
    expect(encodeTerminalData({ terminalId: 't_1', sessionId: 's_1', chunk: '$ ls\r\n' }))
      .toEqual({ terminalId: 't_1', sessionId: 's_1', chunk: '$ ls\r\n' })
  })
})

describe('startup ordering', () => {
  function gatedConnect(fake: FakeDaemon) {
    let open!: () => void
    let fail!: (err: Error) => void
    let connects = 0
    const gate = new Promise<void>((resolve, reject) => { open = resolve; fail = reject })
    // Rejected possibly before connect() awaits it; the awaiting callers own the error.
    gate.catch(() => undefined)
    return {
      connect: async () => { connects++; await gate; return fake },
      open: () => open(),
      fail: (err: Error) => fail(err),
      connects: () => connects,
    }
  }

  // The window is created before main's workspace.ensure finishes; a renderer call
  // in that window used to fail "Workspace is not attached" (settings.get lost the
  // saved layouts that way).
  test('a call made while the workspace is attaching waits for it', async () => {
    const fake = new FakeDaemon()
    const gate = gatedConnect(fake)
    const { bridge } = makeBridge({ fake, connect: gate.connect, saved: '/tmp/demo' })
    const ensuring = bridge.handle('workspace.ensure', { projectRoot: '/tmp/demo' })
    const listing = bridge.handle('session.list', {})
    gate.open()
    await ensuring
    expect(await listing).toEqual([{ id: 's1', name: 'alpha' }])
  })

  // Main attaches at launch and the renderer's first load asks again: queueing the
  // second behind the first doubled the wait before a dead daemon was reported, and
  // spawned a second daemon to find out.
  test('an ensure for the current root joins the one in flight, failure included', async () => {
    const fake = new FakeDaemon()
    const gate = gatedConnect(fake)
    const { bridge } = makeBridge({ fake, connect: gate.connect, saved: '/tmp/demo' })
    const fromMain = bridge.handle('workspace.ensure', { projectRoot: '/tmp/demo' })
    const fromRenderer = bridge.handle('workspace.ensure')
    gate.fail(new Error('DAEMON_START_FAILED'))
    const [main, renderer] = await Promise.allSettled([fromMain, fromRenderer])
    expect(main.status === 'rejected' && String(main.reason)).toContain('DAEMON_START_FAILED')
    expect(renderer.status === 'rejected' && String(renderer.reason)).toContain('DAEMON_START_FAILED')
    expect(gate.connects()).toBe(1)
  })
})

describe('workspace.gc', () => {
  test('always collects the attached workspace, whatever id the renderer sends', async () => {
    const { bridge, fake } = makeBridge({ saved: '/tmp/demo' })
    await bridge.handle('workspace.ensure', { projectRoot: '/tmp/demo' })
    await bridge.handle('workspace.gc', { id: 'ws_other', force: true })
    expect(fake.calls.at(-1)).toMatchObject({ method: 'workspace.gc', params: { id: 'ws_1', force: true } })
  })
})

describe('many projects in one window', () => {
  function multi(isPlain?: (root: string) => boolean) {
    const fakes = new Map<string, FakeDaemon>()
    let open: string[] = []
    let forgot = 0
    const events: Array<{ event: CockpitEvent; payload: unknown }> = []
    const bridge = new DaemonBridge({
      connect: async (root) => {
        const fake = new FakeDaemon()
        fake.responses['workspace.init'] = { id: `ws_${root}`, name: root.split('/').pop(), rootPath: root }
        fake.responses['session.list'] = [{ id: `s_${root}`, name: 'main' }]
        fakes.set(root, fake)
        return fake
      },
      pickFolder: async () => '/tmp/picked',
      loadSavedRoot: () => undefined,
      saveRoot: () => undefined,
      loadOpenRoots: () => open,
      saveOpenRoots: (roots) => { open = roots },
      ...(isPlain ? { isPlain } : {}),
      forgetSavedRoot: () => { forgot += 1 },
      exists: () => true,
      send: (event, payload) => { events.push({ event, payload }) },
    })
    return { bridge, fakes, events, open: () => open, forgotten: () => forgot }
  }

  // A plain folder (no git) is marked, so the rail and the new-session picker know it
  // has no worktrees; and a plain project's snapshot says it has no git.
  test('lists which open projects are plain folders, and a plain project has no git', async () => {
    const { bridge, fakes } = multi((root) => root === '/w/notes')
    await bridge.handle('workspace.ensure', { projectRoot: '/w/api' })
    await bridge.handle('workspace.ensure', { projectRoot: '/w/notes' })
    expect(await bridge.handle('projects.list')).toMatchObject({ open: ['/w/api', '/w/notes'], plain: ['/w/notes'] })
    fakes.get('/w/notes')!.responses['workspace.init'] = { id: 'ws_n', name: 'notes', rootPath: '/w/notes', git: false }
    expect(await bridge.handle('projects.sessions', { projectRoot: '/w/api' })).toMatchObject({ git: true })
  })

  // Switching project used to close the previous daemon connection: a window could
  // only ever know one repository.
  test('attaching a second project keeps the first, and both are listed as open', async () => {
    const { bridge, fakes, open } = multi()
    await bridge.handle('workspace.ensure', { projectRoot: '/w/api' })
    await bridge.handle('workspace.ensure', { projectRoot: '/w/web' })
    expect(fakes.get('/w/api')!.closed).toBe(false)
    expect(open()).toEqual(['/w/api', '/w/web'])
    expect(await bridge.handle('projects.list')).toEqual({ active: '/w/web', open: ['/w/api', '/w/web'], plain: [] })
    // Everything else still targets the active project.
    await bridge.handle('session.list', {})
    expect(fakes.get('/w/web')!.calls.at(-1)).toMatchObject({ method: 'session.list', params: { workspaceId: 'ws_/w/web' } })
  })

  test('the sessions of any open project, connecting to it if needed', async () => {
    const { bridge } = multi()
    await bridge.handle('workspace.ensure', { projectRoot: '/w/api' })
    expect(await bridge.handle('projects.sessions', { projectRoot: '/w/other' })).toMatchObject({
      projectRoot: '/w/other', name: 'other', sessions: [{ id: 's_/w/other', name: 'main' }],
    })
  })

  // A project off the stage keeps its panes alive in the window: its output and its
  // changes reach the renderer like the active one's, tagged so the right view takes them.
  test('a background project still streams, tagged with its root', async () => {
    const { bridge, fakes, events } = multi()
    await bridge.handle('workspace.ensure', { projectRoot: '/w/api' })
    await bridge.handle('workspace.ensure', { projectRoot: '/w/web' })
    fakes.get('/w/api')!.emit('tui.invalidate', {})
    fakes.get('/w/api')!.emit('session.data', { sessionId: 's', chunk: 'x' })
    expect(events).toEqual([
      { event: 'tui.invalidate', payload: { projectRoot: '/w/api' } },
      { event: 'session.data', payload: { sessionId: 's', chunk: 'x', projectRoot: '/w/api' } },
    ])
  })

  test('a background daemon going away is reported for that project; the active one stays attached', async () => {
    const { bridge, fakes, events } = multi()
    await bridge.handle('workspace.ensure', { projectRoot: '/w/api' })
    await bridge.handle('workspace.ensure', { projectRoot: '/w/web' })
    fakes.get('/w/api')!.drop()
    expect(events).toEqual([{ event: 'daemon.gone', payload: { projectRoot: '/w/api' } }])
    expect(await bridge.handle('projects.list')).toMatchObject({ active: '/w/web' })
  })

  test('closing a project forgets it and drops its connection', async () => {
    const { bridge, fakes, open } = multi()
    await bridge.handle('workspace.ensure', { projectRoot: '/w/api' })
    await bridge.handle('workspace.ensure', { projectRoot: '/w/web' })
    await bridge.handle('projects.close', { projectRoot: '/w/api' })
    expect(open()).toEqual(['/w/web'])
    expect(fakes.get('/w/api')!.closed).toBe(true)
  })

  // The project menu closes the active project too (it used to refuse): the window
  // detaches, and the next launch starts on the welcome instead of reopening it.
  test('closing the active project detaches the window and forgets it as the last one', async () => {
    const { bridge, fakes, open, forgotten } = multi()
    await bridge.handle('workspace.ensure', { projectRoot: '/w/api' })
    await bridge.handle('projects.close', { projectRoot: '/w/api' })
    expect(open()).toEqual([])
    expect(fakes.get('/w/api')!.closed).toBe(true)
    expect(forgotten()).toBe(1)
    expect(await bridge.handle('projects.list')).toEqual({ active: undefined, open: [], plain: [] })
    await expect(bridge.handle('session.list', {})).rejects.toThrow(/not attached/)
  })

  // Any call a project's view makes goes to that project's daemon, stage or not.
  test('routes any RPC to another open project, and refuses a project that is not open', async () => {
    const { bridge, fakes } = multi()
    await bridge.handle('workspace.ensure', { projectRoot: '/w/api' })
    await bridge.handle('workspace.ensure', { projectRoot: '/w/web' })
    await bridge.handle('session.rename', { projectRoot: '/w/api', idOrName: 'a', newName: 'b' })
    // projectRoot names the daemon; it is not passed on.
    expect(fakes.get('/w/api')!.calls.at(-1)?.params).not.toHaveProperty('projectRoot')
    expect(fakes.get('/w/api')!.calls.at(-1)).toMatchObject({ method: 'session.rename', params: { idOrName: 'a', newName: 'b', workspaceId: 'ws_/w/api' } })
    await bridge.handle('workspace.gc', { projectRoot: '/w/api', force: false })
    expect(fakes.get('/w/api')!.calls.at(-1)).toMatchObject({ method: 'workspace.gc', params: { id: 'ws_/w/api', workspaceId: 'ws_/w/api' } })
    await bridge.handle('session.input', { projectRoot: '/w/api', idOrName: 'a', data: 'ls\r' })
    expect(fakes.get('/w/api')!.calls.at(-1)).toMatchObject({ method: 'session.input', params: { idOrName: 'a', data: 'ls\r', workspaceId: 'ws_/w/api' } })
    await expect(bridge.handle('session.rename', { projectRoot: '/etc', idOrName: 'a', newName: 'b' })).rejects.toThrow(/not open/)
    // The active project's own root is just the active project.
    await bridge.handle('session.rename', { projectRoot: '/w/web', idOrName: 'x', newName: 'y' })
    expect(fakes.get('/w/web')!.calls.at(-1)).toMatchObject({ method: 'session.rename', params: { idOrName: 'x', newName: 'y', workspaceId: 'ws_/w/web' } })
  })

  test('reorder takes the open projects in a new order, and nothing else', async () => {
    const { bridge, open } = multi()
    await bridge.handle('workspace.ensure', { projectRoot: '/w/api' })
    await bridge.handle('workspace.ensure', { projectRoot: '/w/web' })
    await bridge.handle('projects.reorder', { roots: ['/w/web', '/w/api'] })
    expect(open()).toEqual(['/w/web', '/w/api'])
    for (const roots of [['/w/web'], ['/w/web', '/w/web'], ['/w/web', '/etc'], 'x', [1, 2]]) {
      await expect(bridge.handle('projects.reorder', { roots })).rejects.toThrow(/reordered/)
    }
    expect(open()).toEqual(['/w/web', '/w/api'])
  })
})
