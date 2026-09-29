import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserAgent, type Activity, type GuestLike } from '../electron/browser-agent'

type Handler = (params: any) => unknown

class FakeGuest implements GuestLike {
  attached = false
  busy = false
  calls: Array<[string, any]> = []
  handlers: Record<string, Handler> = {}
  private destroyedCbs: Array<() => void> = []
  private message: Array<(e: unknown, method: string, params: unknown) => void> = []
  private detach: Array<(e: unknown, reason: string) => void> = []
  gone = false
  constructor(public id: number, public url = 'http://localhost:3000/') {}
  isDestroyed(): boolean { return this.gone }
  getURL(): string { return this.url }
  once(_e: 'destroyed', l: () => void): void { this.destroyedCbs.push(l) }
  debugger = {
    attach: (_v: string): void => { if (this.busy) throw new Error('Another debugger is already attached to the WebContents.'); this.attached = true },
    detach: (): void => { this.attached = false },
    isAttached: (): boolean => this.attached,
    sendCommand: async (method: string, params?: object): Promise<any> => {
      this.calls.push([method, params])
      const h = this.handlers[method]
      return h ? h(params) : {}
    },
    on: (event: string, l: (...a: any[]) => void): void => { (event === 'message' ? this.message : this.detach).push(l) },
  }
  cdp(method: string, params: unknown): void { for (const l of this.message) l({}, method, params) }
  dropDebugger(reason = 'target closed'): void { this.attached = false; for (const l of this.detach) l({}, reason) }
  destroy(): void { this.gone = true; for (const l of this.destroyedCbs) l() }
  count(method: string): number { return this.calls.filter(([m]) => m === method).length }
}

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function setup(over: { confirm?: (q: { title: string; body: string }) => Promise<boolean>; confirmTimeoutMs?: number; budgetMs?: number; minAnswerMs?: number; realClock?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cw-browser-')))
  dirs.push(root)
  const guests = new Map<number, FakeGuest>()
  const asked: Array<{ title: string; body: string }> = []
  const activity: Activity[] = []
  let now = 1_000_000
  const agent = new BrowserAgent({
    guest: (id) => guests.get(id) ?? null,
    confirm: async (q) => { asked.push({ title: q.title, body: q.body }); return over.confirm ? over.confirm(q) : true },
    now: () => (over.realClock === true ? Date.now() : now),
    emit: (a) => activity.push(a),
    ...(over.confirmTimeoutMs === undefined ? {} : { confirmTimeoutMs: over.confirmTimeoutMs }),
    ...(over.budgetMs === undefined ? {} : { budgetMs: over.budgetMs }),
    ...(over.minAnswerMs === undefined ? {} : { minAnswerMs: over.minAnswerMs }),
  })
  const add = (id: number, url?: string): FakeGuest => { const g = new FakeGuest(id, url); guests.set(id, g); return g }
  const ctx = { projectRoot: root }
  const access = (paneId: string, webContentsId: number, level: string, projectRoot = root) => agent.setAccess({ paneId, webContentsId, level, projectRoot })
  const run = (kind: string, params: unknown = {}, c = ctx) => agent.handle(kind, params, c)
  const code = async (p: Promise<unknown>): Promise<string> => { try { await p; return 'ok' } catch (e) { return (e as { code?: string }).code ?? 'no-code' } }
  return { agent, add, root, ctx, access, run, code, asked, activity, tick: (ms: number) => { now += ms } }
}

describe('registration and levels', () => {
  test('a pane that registers is off: nothing attaches and nothing is readable', async () => {
    const t = setup(); const g = t.add(1)
    expect(await t.access('p1', 1, 'off')).toEqual({ ok: true })
    expect(g.attached).toBe(false)
    expect(await t.code(t.run('browser.console'))).toBe('BROWSER_PANE_OFF')
  })

  test('a webContents that is not a webview guest of the window is refused', async () => {
    const t = setup()
    expect(await t.access('p1', 99, 'read')).toMatchObject({ ok: false, code: 'BROWSER_NO_PANE' })
  })

  test('a malformed request is refused, not thrown', async () => {
    const t = setup(); t.add(1)
    for (const bad of [null, 'x', { paneId: 1 }, { paneId: 'p', webContentsId: 1.5, level: 'read', projectRoot: '/x' }, { paneId: 'p', webContentsId: 1, level: 'root', projectRoot: '/x' }, { paneId: 'p', webContentsId: 1, level: 'read' }]) {
      expect(await t.agent.setAccess(bad)).toMatchObject({ ok: false })
    }
  })

  test('read attaches once and turns the capture domains on; going up to control does not attach again', async () => {
    const t = setup(); const g = t.add(1)
    await t.access('p1', 1, 'read')
    await t.access('p1', 1, 'control')
    expect(g.attached).toBe(true)
    expect(g.count('Network.enable')).toBe(1)
    expect(g.count('Runtime.enable')).toBe(1)
  })

  test('off detaches and forgets what was captured', async () => {
    const t = setup(); const g = t.add(1)
    await t.access('p1', 1, 'read')
    g.cdp('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'hello' }] })
    expect(await t.run('browser.console') as unknown[]).toHaveLength(1)
    await t.access('p1', 1, 'off')
    expect(g.attached).toBe(false)
    await t.access('p1', 1, 'read')
    expect(await t.run('browser.console') as unknown[]).toHaveLength(0)
  })

  test('DevTools owning the target is BROWSER_DEBUGGER_BUSY and the pane stays off', async () => {
    const t = setup(); const g = t.add(1); g.busy = true
    expect(await t.access('p1', 1, 'read')).toMatchObject({ ok: false, code: 'BROWSER_DEBUGGER_BUSY' })
    expect(await t.code(t.run('browser.console'))).toBe('BROWSER_PANE_OFF')
  })

  test('a destroyed webview drops the pane', async () => {
    const t = setup(); const g = t.add(1)
    await t.access('p1', 1, 'read')
    g.destroy()
    expect(await t.code(t.run('browser.console'))).toBe('BROWSER_NO_PANE')
  })

  test('the debugger detaching under us turns the pane off and says so', async () => {
    const t = setup(); const g = t.add(1)
    await t.access('p1', 1, 'read')
    g.dropDebugger()
    expect(await t.code(t.run('browser.console'))).toBe('BROWSER_PANE_OFF')
    expect(t.activity.at(-1)).toMatchObject({ paneId: 'p1', command: 'detached' })
  })

  test('the same pane id on a new webview replaces the old one and detaches it', async () => {
    const t = setup(); const a = t.add(1); const b = t.add(2)
    await t.access('p1', 1, 'read')
    await t.access('p1', 2, 'read')
    expect(a.attached).toBe(false)
    expect(b.attached).toBe(true)
  })
})

describe('addressing', () => {
  test('list shows this project\'s panes and their level, and never touches a page', async () => {
    const t = setup(); const g = t.add(1); t.add(2)
    await t.access('p1', 1, 'read')
    await t.access('other', 2, 'control', '/some/other/project')
    const calls = g.calls.length
    expect(await t.run('browser.list')).toEqual([{ paneId: 'p1', level: 'read' }])
    expect(g.calls.length).toBe(calls)
  })

  test('the default pane is the only one of the project; two need --pane; another project\'s is out of reach', async () => {
    const t = setup(); t.add(1); t.add(2); t.add(3)
    await t.access('p1', 1, 'read')
    await t.access('p2', 2, 'read')
    await t.access('foreign', 3, 'read', '/some/other/project')
    expect(await t.code(t.run('browser.console'))).toBe('BROWSER_NO_PANE')
    expect(await t.code(t.run('browser.console', { pane: 'p2' }))).toBe('ok')
    expect(await t.code(t.run('browser.console', { pane: 'foreign' }))).toBe('BROWSER_NO_PANE')
  })

  test('an unknown kind is refused', async () => {
    const t = setup()
    expect(await t.code(t.run('browser.rm-rf'))).toBe('BRIDGE_UNSUPPORTED_KIND')
  })
})

describe('reads', () => {
  test('console and network come back redacted, filtered, and marked untrusted', async () => {
    const t = setup(); const g = t.add(1)
    await t.access('p1', 1, 'read')
    g.cdp('Runtime.consoleAPICalled', { type: 'error', args: [{ type: 'string', value: 'boom ?token=abc' }] })
    g.cdp('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'fine' }] })
    g.cdp('Network.requestWillBeSent', { requestId: '1', timestamp: 1, request: { url: 'http://x/a?apikey=q', method: 'GET' } })
    g.cdp('Network.loadingFailed', { requestId: '1', timestamp: 1.5, errorText: 'net::ERR_FAILED' })
    expect(await t.run('browser.console', { level: 'error' })).toEqual([{ t: 1_000_000, level: 'error', text: 'boom ?token=[redacted]', untrusted: true }])
    expect(await t.run('browser.network', { failed: true })).toMatchObject([{ url: 'http://x/a?apikey=[redacted]', failed: true, untrusted: true }])
  })

  test('dom returns the rendered text, capped, and says the page wrote it', async () => {
    const t = setup(); const g = t.add(1)
    await t.access('p1', 1, 'read')
    g.handlers['Runtime.evaluate'] = () => ({ result: { value: { text: 'x'.repeat(50) } } })
    expect(await t.run('browser.dom', { max: 10 })).toEqual({ text: 'x'.repeat(10), truncated: true, untrusted: true })
  })

  test('a selector that matches nothing, or is invalid, is BROWSER_BAD_SELECTOR', async () => {
    const t = setup(); const g = t.add(1)
    await t.access('p1', 1, 'read')
    g.handlers['Runtime.evaluate'] = () => ({ result: { value: { error: 'missing' } } })
    expect(await t.code(t.run('browser.dom', { selector: '#nope' }))).toBe('BROWSER_BAD_SELECTOR')
    g.handlers['Runtime.evaluate'] = () => ({ result: { value: { error: 'bad' } } })
    expect(await t.code(t.run('browser.dom', { selector: '<<<' }))).toBe('BROWSER_BAD_SELECTOR')
  })

  test('shot: main writes the PNG under .crossweave/shots and returns only its path', async () => {
    const t = setup(); const g = t.add(1)
    await t.access('p1', 1, 'read')
    g.handlers['Page.captureScreenshot'] = () => ({ data: Buffer.from('PNGDATA').toString('base64') })
    const res = await t.run('browser.shot') as { path: string }
    expect(res.path.startsWith(join(t.root, '.crossweave', 'shots') + '/')).toBe(true)
    expect(readFileSync(res.path, 'utf8')).toBe('PNGDATA')
    expect(Object.keys(res)).toEqual(['path'])
  })

  test('shot keeps only the newest 20', async () => {
    const t = setup(); const g = t.add(1)
    await t.access('p1', 1, 'read')
    g.handlers['Page.captureScreenshot'] = () => ({ data: Buffer.from('x').toString('base64') })
    for (let i = 0; i < 23; i++) { await t.run('browser.shot'); t.tick(5) }
    expect(readdirSync(join(t.root, '.crossweave', 'shots'))).toHaveLength(20)
  })

  test('shot refuses an image over 8 MB and writes nothing', async () => {
    const t = setup(); const g = t.add(1)
    await t.access('p1', 1, 'read')
    g.handlers['Page.captureScreenshot'] = () => ({ data: Buffer.alloc(9 * 1024 * 1024).toString('base64') })
    expect(await t.code(t.run('browser.shot'))).toBe('BROWSER_TOO_LARGE')
    expect(existsSync(join(t.root, '.crossweave', 'shots')) ? readdirSync(join(t.root, '.crossweave', 'shots')) : []).toEqual([])
  })

  test('every executed command shows up in the activity line, without its output', async () => {
    const t = setup(); t.add(1)
    await t.access('p1', 1, 'read')
    await t.run('browser.console')
    expect(t.activity).toEqual([{ t: 1_000_000, paneId: 'p1', command: 'console', target: '' }])
  })
})

describe('control', () => {
  const click = { selector: '#go' }
  const pointAt = (g: FakeGuest): void => { g.handlers['Runtime.evaluate'] = () => ({ result: { value: { x: 10, y: 20 } } }) }

  test('a click on a local origin runs without asking', async () => {
    const t = setup(); const g = t.add(1); pointAt(g)
    await t.access('p1', 1, 'control')
    await t.run('browser.click', click)
    expect(t.asked).toEqual([])
    expect(g.count('Input.dispatchMouseEvent')).toBe(3)
  })

  test('on another origin the person is asked, naming the command and the origin; a refusal does nothing', async () => {
    const t = setup({ confirm: async () => false }); const g = t.add(1, 'https://example.com/a'); pointAt(g)
    await t.access('p1', 1, 'control')
    expect(await t.code(t.run('browser.click', click))).toBe('BROWSER_NEEDS_CONFIRM')
    expect(t.asked[0]?.body).toContain('click')
    expect(t.asked[0]?.body).toContain('example.com')
    expect(g.count('Input.dispatchMouseEvent')).toBe(0)
  })

  test('read level cannot control at all, and is not even asked', async () => {
    const t = setup(); const g = t.add(1); pointAt(g)
    await t.access('p1', 1, 'read')
    expect(await t.code(t.run('browser.click', click))).toBe('BROWSER_PANE_OFF')
    expect(t.asked).toEqual([])
  })

  test('eval always asks, even on localhost, and shows the script', async () => {
    const t = setup(); const g = t.add(1)
    g.handlers['Runtime.evaluate'] = () => ({ result: { value: 42 } })
    await t.access('p1', 1, 'control')
    expect(await t.run('browser.eval', { script: 'document.title' })).toEqual({ value: 42 })
    expect(t.asked).toHaveLength(1)
    expect(t.asked[0]?.body).toContain('document.title')
  })

  test('eval: a result that cannot be serialised, an exception and a runaway script have their own codes', async () => {
    const t = setup(); const g = t.add(1)
    await t.access('p1', 1, 'control')
    g.handlers['Runtime.evaluate'] = () => { throw new Error('Object reference chain is too long') }
    expect(await t.code(t.run('browser.eval', { script: 'document.body' }))).toBe('BROWSER_EVAL_UNSERIALIZABLE')
    g.handlers['Runtime.evaluate'] = () => ({ exceptionDetails: { text: 'Uncaught', exception: { description: 'ReferenceError: x' } } })
    expect(await t.code(t.run('browser.eval', { script: 'x' }))).toBe('BROWSER_EVAL_FAILED')
    g.handlers['Runtime.evaluate'] = () => ({ exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: Execution was terminated' } } })
    expect(await t.code(t.run('browser.eval', { script: 'for(;;){}' }))).toBe('BROWSER_TIMEOUT')
  })

  test('eval result over 64 KB is refused rather than sent', async () => {
    const t = setup(); const g = t.add(1)
    await t.access('p1', 1, 'control')
    g.handlers['Runtime.evaluate'] = () => ({ result: { value: 'y'.repeat(70_000) } })
    expect(await t.code(t.run('browser.eval', { script: 'big()' }))).toBe('BROWSER_TOO_LARGE')
  })

  test('the origin is read at execution: a page that moved while the dialog was open is refused', async () => {
    let g!: FakeGuest
    const t = setup({ confirm: async () => { g.url = 'https://evil.example/'; return true } })
    g = t.add(1, 'https://example.com/'); pointAt(g)
    await t.access('p1', 1, 'control')
    expect(await t.code(t.run('browser.click', click))).toBe('BROWSER_NEEDS_CONFIRM')
    expect(g.count('Input.dispatchMouseEvent')).toBe(0)
  })

  test('no answer in time is a refusal', async () => {
    const t = setup({ confirm: () => new Promise<boolean>(() => undefined), confirmTimeoutMs: 30 }); const g = t.add(1, 'https://example.com/'); pointAt(g)
    await t.access('p1', 1, 'control')
    expect(await t.code(t.run('browser.click', click))).toBe('BROWSER_NEEDS_CONFIRM')
    expect(g.count('Input.dispatchMouseEvent')).toBe(0)
  })

  test('prompts are shown one at a time', async () => {
    let open = 0; let peak = 0
    const t = setup({ confirm: async () => { open++; peak = Math.max(peak, open); await new Promise((r) => setTimeout(r, 15)); open--; return true } })
    const g = t.add(1, 'https://example.com/'); pointAt(g)
    await t.access('p1', 1, 'control')
    await Promise.all([t.run('browser.click', click), t.run('browser.click', click), t.run('browser.click', click)])
    expect(peak).toBe(1)
    expect(t.asked).toHaveLength(3)
  })

  test('a request that waited out its budget in the queue is refused without a dialog', async () => {
    const t = setup({ confirm: () => new Promise<boolean>((r) => setTimeout(() => r(true), 40)), budgetMs: 50, minAnswerMs: 30, confirmTimeoutMs: 200, realClock: true })
    const g = t.add(1, 'https://example.com/'); pointAt(g)
    await t.access('p1', 1, 'control')
    const [a, b] = await Promise.all([t.code(t.run('browser.click', click)), t.code(t.run('browser.click', click))])
    expect([a, b]).toEqual(['ok', 'BROWSER_NEEDS_CONFIRM'])
    expect(t.asked).toHaveLength(1)
  })

  test('navigate takes http(s) only and is judged by the origin it leaves', async () => {
    const t = setup(); const g = t.add(1)
    await t.access('p1', 1, 'control')
    expect(await t.code(t.run('browser.navigate', { url: 'file:///etc/passwd' }))).toBe('BROWSER_BAD_URL')
    expect(await t.code(t.run('browser.navigate', { url: 'javascript:alert(1)' }))).toBe('BROWSER_BAD_URL')
    expect(await t.code(t.run('browser.navigate', { url: 'https://example.com/' }))).toBe('ok') // leaving localhost: no dialog
    expect(t.asked).toEqual([])
    expect(g.calls.find(([m]) => m === 'Page.navigate')?.[1]).toEqual({ url: 'https://example.com/' })
    g.url = 'https://example.com/'
    await t.run('browser.navigate', { url: 'http://localhost:3000/' })
    expect(t.asked).toHaveLength(1) // leaving a non-local page asks
  })

  test('type focuses the element and inserts the text, without logging the text in the activity line', async () => {
    const t = setup(); const g = t.add(1)
    g.handlers['Runtime.evaluate'] = () => ({ result: { value: { ok: true } } })
    await t.access('p1', 1, 'control')
    await t.run('browser.type', { selector: '#pw', text: 'hunter2' })
    expect(g.calls.find(([m]) => m === 'Input.insertText')?.[1]).toEqual({ text: 'hunter2' })
    expect(JSON.stringify(t.activity)).not.toContain('hunter2')
  })

  test('parameters are validated: no selector, a huge script, a wrong type', async () => {
    const t = setup(); t.add(1)
    await t.access('p1', 1, 'control')
    expect(await t.code(t.run('browser.click', {}))).toBe('INVALID_ARGUMENTS')
    expect(await t.code(t.run('browser.eval', { script: 'x'.repeat(20_000) }))).toBe('INVALID_ARGUMENTS')
    expect(await t.code(t.run('browser.type', { selector: 's', text: 5 }))).toBe('INVALID_ARGUMENTS')
    expect(await t.code(t.run('browser.console', 'nope'))).toBe('INVALID_ARGUMENTS')
  })
})
