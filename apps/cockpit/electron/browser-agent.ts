import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Capture, DEFAULT_LIMIT, queryConsole, queryNetwork } from '../../../src/core/browser-agent/capture.js'
import { collectBrowserErrors, type BrowserErrorRow } from '../../../src/core/browser-agent/errors.js'
import { isLocalOrigin, originOf } from '../../../src/core/browser-agent/origin.js'
import { BROWSER_COMMANDS, decide, type AccessLevel, type BrowserCommand } from '../../../src/core/browser-agent/permission.js'
import { clip } from '../../../src/core/browser-agent/ring.js'
import { CrossweaveError } from '../../../src/core/errors.js'
import { assertContained } from '../../../src/core/paths.js'

/** The slice of Electron's `webContents.debugger` this file uses, so it can be driven by a fake. */
export interface DebuggerLike {
  attach(protocolVersion: string): void
  detach(): void
  isAttached(): boolean
  sendCommand(method: string, params?: object): Promise<any>
  on(event: 'message', listener: (event: unknown, method: string, params: unknown) => void): unknown
  on(event: 'detach', listener: (event: unknown, reason: string) => void): unknown
}

/** A `webview` guest hosted by the cockpit window — the only kind of page this file will ever attach to. */
export interface GuestLike {
  id: number
  isDestroyed(): boolean
  getURL(): string
  once(event: 'destroyed', listener: () => void): unknown
  debugger: DebuggerLike
}

export interface Activity { t: number; paneId: string; command: string; target: string }

export interface BrowserAgentDeps {
  /** Main validates that the id is a webview guest of the cockpit window; anything else is null. */
  guest: (webContentsId: number) => GuestLike | null
  /** The native dialog. `signal` aborts it when the answer window has closed. */
  confirm: (q: { title: string; body: string; confirmLabel: string }, signal: AbortSignal) => Promise<boolean>
  now?: () => number
  emit?: (activity: Activity) => void
  /** How long the person has to answer one dialog. */
  confirmTimeoutMs?: number
  /** How long a request may wait in the queue plus the dialog before the CLI has given up on it. */
  budgetMs?: number
  /** A dialog with less time left than this is not shown: nobody could answer it before the CLI gives up. */
  minAnswerMs?: number
  cdpTimeoutMs?: number
}

interface Pane {
  paneId: string
  projectRoot: string
  guest: GuestLike
  level: AccessLevel
  capture: Capture | undefined
}

const err = (code: string, message: string): CrossweaveError => new CrossweaveError(code, message)
const invalid = (message: string): CrossweaveError => err('INVALID_ARGUMENTS', message)
const LEVELS: ReadonlySet<string> = new Set(['off', 'read', 'control'])
const DOM_DEFAULT_CHARS = 20_000
const DOM_MAX_CHARS = 100_000
const EVAL_RESULT_CAP = 64 * 1024
const SHOT_CAP = 8 * 1024 * 1024
const SHOTS_KEPT = 20
const SCRIPT_CAP = 10_000
const TEXT_CAP = 10_000
const SELECTOR_CAP = 1_000
const ID_CAP = 64

const obj = (v: unknown): Record<string, unknown> => {
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as Record<string, unknown>
  throw invalid('Parameters must be an object')
}
function text(p: Record<string, unknown>, key: string, cap: number, required: boolean): string | undefined {
  const v = p[key]
  if (v === undefined) { if (required) throw invalid(`${key} is required`); return undefined }
  if (typeof v !== 'string' || v.length > cap || (required && v === '')) throw invalid(`${key} must be a string of at most ${cap} characters`)
  return v
}
function count(p: Record<string, unknown>, key: string, max: number): number | undefined {
  const v = p[key]
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max) throw invalid(`${key} must be a number from 0 to ${max}`)
  return v
}

/**
 * Lets the session's agent read and drive a Browser pane through the command bridge. EVERY decision is here,
 * in the main process, never in the daemon or the renderer: a pane starts `off`, the level is the person's
 * switch, control outside localhost (and `eval` anywhere) asks a native dialog for that one command, and the
 * page's origin is read from the live guest at execution — never from the request. The page is reached only
 * through the debugger of a webview guest main itself validated, and only while a pane is above `off`.
 */
export class BrowserAgent {
  private readonly panes = new Map<string, Pane>()
  /** guest id → how many panes hold it attached; the debugger detaches when the last lets go. */
  private readonly attachments = new Map<number, number>()
  private queue: Promise<unknown> = Promise.resolve()
  private shotSeq = 0

  constructor(private readonly deps: BrowserAgentDeps) {}

  private now(): number { return this.deps.now?.() ?? Date.now() }

  /** From the renderer's switch (and when a pane mounts, at `off`). Never throws: the answer says what happened. */
  async setAccess(payload: unknown): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
    try {
      const p = obj(payload)
      const paneId = text(p, 'paneId', ID_CAP, true) as string
      const projectRoot = text(p, 'projectRoot', 4096, true) as string
      const id = p['webContentsId']
      const level = p['level']
      if (typeof id !== 'number' || !Number.isInteger(id)) throw invalid('webContentsId must be an integer')
      if (typeof level !== 'string' || !LEVELS.has(level)) throw invalid('level must be off, read or control')
      const guest = this.deps.guest(id)
      if (guest === null || guest.isDestroyed()) throw err('BROWSER_NO_PANE', 'That page is not a browser pane of this window')
      this.apply(paneId, projectRoot, guest, level as AccessLevel)
      return { ok: true }
    } catch (e) {
      if (e instanceof CrossweaveError) return { ok: false, code: e.code, message: e.message }
      return { ok: false, code: 'BROWSER_FAILED', message: 'The cockpit could not change that pane' }
    }
  }

  /**
   * What the Debug pane shows from this project's READABLE browser panes: their console
   * errors and failed requests, tagged and bounded. Read-only — it asks nobody and writes
   * no activity line — and a bad payload reads as nothing rather than failing the pane.
   */
  readErrors(projectRoot: unknown): { rows: BrowserErrorRow[] } {
    if (typeof projectRoot !== 'string' || projectRoot === '' || projectRoot.length > 4096) return { rows: [] }
    const mine = [...this.panes.values()].filter((x) => x.projectRoot === projectRoot && x.level !== 'off')
    return { rows: collectBrowserErrors(mine.map((x) => ({ paneId: x.paneId, console: x.capture?.console() ?? [], network: x.capture?.network() ?? [] }))) }
  }

  private apply(paneId: string, projectRoot: string, guest: GuestLike, level: AccessLevel): void {
    let pane = this.panes.get(paneId)
    if (pane !== undefined && pane.guest.id !== guest.id) { this.forget(pane); pane = undefined }
    if (pane === undefined) {
      pane = { paneId, projectRoot, guest, level: 'off', capture: undefined }
      this.panes.set(paneId, pane)
      this.watch(pane)
    }
    pane.projectRoot = projectRoot
    if (level !== 'off' && pane.capture === undefined) this.start(pane)
    if (level === 'off' && pane.capture !== undefined) this.stop(pane)
    pane.level = level
  }

  private watch(pane: Pane): void {
    const g = pane.guest
    g.once('destroyed', () => { if (this.panes.get(pane.paneId) === pane) this.forget(pane) })
    g.debugger.on('message', (_e, method, params) => { pane.capture?.event(method, params) })
    g.debugger.on('detach', () => {
      // The debugger went away under us (DevTools took the target, the page crashed): fail closed to off.
      if (pane.capture === undefined) return
      pane.capture.clear()
      pane.capture = undefined
      pane.level = 'off'
      this.attachments.delete(g.id)
      this.deps.emit?.({ t: this.now(), paneId: pane.paneId, command: 'detached', target: '' })
    })
  }

  private start(pane: Pane): void {
    const g = pane.guest
    const held = this.attachments.get(g.id) ?? 0
    if (held === 0) {
      try { g.debugger.attach('1.3') } catch { throw err('BROWSER_DEBUGGER_BUSY', 'Another debugger (DevTools?) already owns this page') }
    }
    this.attachments.set(g.id, held + 1)
    const capture = new Capture(() => this.now())
    capture.setOrigin(g.getURL())
    pane.capture = capture
    for (const domain of ['Runtime', 'Log', 'Network', 'Page']) void g.debugger.sendCommand(`${domain}.enable`).catch(() => undefined)
  }

  private stop(pane: Pane): void {
    pane.capture?.clear()
    pane.capture = undefined
    const held = (this.attachments.get(pane.guest.id) ?? 1) - 1
    if (held <= 0) {
      this.attachments.delete(pane.guest.id)
      try { if (pane.guest.debugger.isAttached()) pane.guest.debugger.detach() } catch { /* already gone */ }
    } else this.attachments.set(pane.guest.id, held)
  }

  private forget(pane: Pane): void {
    if (pane.capture !== undefined) this.stop(pane)
    this.panes.delete(pane.paneId)
  }

  /** `kind` is `browser.<command>`. Resolves to the result or throws a CrossweaveError with a stable code. */
  async handle(kind: string, params: unknown, ctx: { projectRoot: string }): Promise<unknown> {
    const command = kind.startsWith('browser.') ? kind.slice('browser.'.length) : ''
    if (!(BROWSER_COMMANDS as readonly string[]).includes(command)) throw err('BRIDGE_UNSUPPORTED_KIND', `The cockpit does not serve ${clip(kind, 60)}`)
    const cmd = command as BrowserCommand
    const p = obj(params ?? {})
    const mine = [...this.panes.values()].filter((x) => x.projectRoot === ctx.projectRoot)
    if (cmd === 'list') return mine.map((x) => ({ paneId: x.paneId, level: x.level }))

    const wanted = text(p, 'pane', ID_CAP, false)
    const pane = wanted === undefined ? (mine.length === 1 ? mine[0] : undefined) : mine.find((x) => x.paneId === wanted)
    if (pane === undefined) {
      throw err('BROWSER_NO_PANE', mine.length > 1 && wanted === undefined ? 'There are several browser panes: name one with --pane (see cw browser list)' : 'No such browser pane in this project')
    }
    if (pane.guest.isDestroyed()) { this.forget(pane); throw err('BROWSER_NO_PANE', 'That browser pane is gone') }
    const deadline = this.now() + (this.deps.budgetMs ?? 25_000)
    return this.run(cmd, p, pane, ctx.projectRoot, deadline)
  }

  private async run(cmd: BrowserCommand, p: Record<string, unknown>, pane: Pane, projectRoot: string, deadline: number): Promise<unknown> {
    const started = pane.guest.getURL()
    const decision = decide(cmd, pane.level, isLocalOrigin(started))
    if (!decision.ok) throw err(decision.code, decision.message)

    const args = this.parse(cmd, p)
    if (decision.confirm) {
      await this.confirmOnce(cmd, started, args, deadline)
      // The dialog took time and the page may have moved: what was allowed was THIS origin.
      if (originOf(pane.guest.getURL()) !== originOf(started)) throw err('BROWSER_NEEDS_CONFIRM', 'The page changed while waiting: nothing was done')
      if (pane.guest.isDestroyed() || pane.level !== 'control') throw err('BROWSER_PANE_OFF', 'The pane changed while waiting: nothing was done')
    }
    this.deps.emit?.({ t: this.now(), paneId: pane.paneId, command: cmd, target: this.targetOf(cmd, args) })
    return this.execute(cmd, args, pane, projectRoot)
  }

  private parse(cmd: BrowserCommand, p: Record<string, unknown>): Record<string, unknown> {
    switch (cmd) {
      case 'console': {
        const level = text(p, 'level', 8, false)
        if (level !== undefined && !['error', 'warn', 'info', 'all'].includes(level)) throw invalid('level must be error, warn, info or all')
        return { level, since: count(p, 'since', Number.MAX_SAFE_INTEGER), limit: count(p, 'limit', 100_000) }
      }
      case 'network':
        return { failed: p['failed'] === true, since: count(p, 'since', Number.MAX_SAFE_INTEGER), limit: count(p, 'limit', 100_000) }
      case 'dom': return { selector: text(p, 'selector', SELECTOR_CAP, false), max: count(p, 'max', DOM_MAX_CHARS) ?? DOM_DEFAULT_CHARS }
      case 'shot': return { selector: text(p, 'selector', SELECTOR_CAP, false) }
      case 'navigate': {
        const url = text(p, 'url', 2048, true) as string
        let parsed: URL
        try { parsed = new URL(url) } catch { throw err('BROWSER_BAD_URL', 'navigate takes an http or https address') }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw err('BROWSER_BAD_URL', 'navigate takes an http or https address')
        return { url: parsed.href }
      }
      case 'click': return { selector: text(p, 'selector', SELECTOR_CAP, true) }
      case 'type': return { selector: text(p, 'selector', SELECTOR_CAP, true), text: text(p, 'text', TEXT_CAP, true) }
      case 'eval': return { script: text(p, 'script', SCRIPT_CAP, true) }
      default: return {}
    }
  }

  /** What the activity line shows: where, never what was typed and never a result. */
  private targetOf(cmd: BrowserCommand, a: Record<string, unknown>): string {
    if (cmd === 'navigate') return String(a['url'])
    if (cmd === 'click' || cmd === 'type' || cmd === 'dom' || cmd === 'shot') return typeof a['selector'] === 'string' ? a['selector'] : ''
    if (cmd === 'eval') return clip(String(a['script']), 80)
    return ''
  }

  private describe(cmd: BrowserCommand, origin: string, a: Record<string, unknown>): { title: string; body: string } {
    const host = originOf(origin) ?? 'a blank page'
    switch (cmd) {
      case 'navigate': return { title: 'Let an agent navigate this page?', body: `An agent wants to navigate ${host} to ${String(a['url'])}.` }
      case 'click': return { title: 'Let an agent click?', body: `An agent wants to click ${clip(String(a['selector']), 200)} on ${host}.` }
      case 'type': return { title: 'Let an agent type?', body: `An agent wants to type ${clip(String(a['text']), 200)} into ${clip(String(a['selector']), 200)} on ${host}.` }
      default: return { title: 'Let an agent run a script?', body: `An agent wants to run this script on ${host}:\n\n${clip(String(a['script']), 2000)}` }
    }
  }

  /** One dialog at a time; nothing is remembered; no answer in time, or a queue that ate the budget, is a refusal. */
  private confirmOnce(cmd: BrowserCommand, origin: string, args: Record<string, unknown>, deadline: number): Promise<void> {
    const turn = this.queue.then(async () => {
      const remaining = deadline - this.now()
      if (remaining < (this.deps.minAnswerMs ?? 2000)) throw err('BROWSER_NEEDS_CONFIRM', 'Another request was waiting for you: nothing was done')
      const limit = Math.min(this.deps.confirmTimeoutMs ?? 20_000, remaining)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), limit)
      try {
        const answer = await Promise.race([
          this.deps.confirm({ ...this.describe(cmd, origin, args), confirmLabel: 'Allow once' }, controller.signal).catch(() => false),
          new Promise<false>((resolve) => controller.signal.addEventListener('abort', () => resolve(false), { once: true })),
        ])
        if (answer !== true) throw err('BROWSER_NEEDS_CONFIRM', controller.signal.aborted ? 'Nobody answered in time: nothing was done' : 'You refused: nothing was done')
      } finally {
        clearTimeout(timer)
      }
    })
    // A refused turn must not poison the next one in the queue.
    this.queue = turn.catch(() => undefined)
    return turn
  }

  private async send(g: GuestLike, method: string, params?: object, timeoutMs = this.deps.cdpTimeoutMs ?? 10_000): Promise<any> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        g.debugger.sendCommand(method, params),
        new Promise<never>((_r, reject) => { timer = setTimeout(() => reject(err('BROWSER_TIMEOUT', 'The page did not answer in time')), timeoutMs) }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** A JSON-returning expression over the page; the helpers below pass the selector as data, never spliced in. */
  private async page<T>(g: GuestLike, expression: string): Promise<T> {
    const res = await this.send(g, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false, timeout: 3000 })
    if (res?.exceptionDetails !== undefined) throw err('BROWSER_EVAL_FAILED', 'The page could not run that')
    return res?.result?.value as T
  }

  private async execute(cmd: BrowserCommand, a: Record<string, unknown>, pane: Pane, projectRoot: string): Promise<unknown> {
    const g = pane.guest
    const cap = pane.capture
    const sel = (a['selector'] as string | undefined)
    switch (cmd) {
      case 'console': return queryConsole(cap?.console() ?? [], { ...(a['level'] === undefined ? {} : { level: a['level'] as 'error' }), ...(a['since'] === undefined ? {} : { since: a['since'] as number }), limit: (a['limit'] as number | undefined) ?? DEFAULT_LIMIT })
      case 'network': return queryNetwork(cap?.network() ?? [], { failed: a['failed'] === true, ...(a['since'] === undefined ? {} : { since: a['since'] as number }), limit: (a['limit'] as number | undefined) ?? DEFAULT_LIMIT })
      case 'dom': {
        const out = await this.page<{ text?: string; error?: string }>(g, `(() => { const s = ${JSON.stringify(sel ?? null)}; let el; try { el = s === null ? document.body : document.querySelector(s) } catch (e) { return { error: 'bad' } } return el === null ? { error: 'missing' } : { text: el.innerText } })()`)
        if (out?.error !== undefined || typeof out?.text !== 'string') throw err('BROWSER_BAD_SELECTOR', 'That selector matches nothing on the page')
        const max = a['max'] as number
        return { text: out.text.slice(0, max), truncated: out.text.length > max, untrusted: true }
      }
      case 'shot': return this.shot(g, sel, projectRoot)
      case 'navigate': {
        const res = await this.send(g, 'Page.navigate', { url: a['url'] })
        if (typeof res?.errorText === 'string') throw err('BROWSER_NAVIGATE_FAILED', clip(res.errorText, 200))
        return { ok: true }
      }
      case 'click': {
        const at = await this.page<{ x?: number; y?: number; error?: string }>(g, `(() => { let el; try { el = document.querySelector(${JSON.stringify(sel)}) } catch (e) { return { error: 'bad' } } if (el === null) return { error: 'missing' }; el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
        if (at?.error !== undefined || typeof at?.x !== 'number' || typeof at.y !== 'number') throw err('BROWSER_BAD_SELECTOR', 'That selector matches nothing on the page')
        const point = { x: at.x, y: at.y, button: 'left', clickCount: 1 }
        await this.send(g, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y })
        await this.send(g, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...point })
        await this.send(g, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...point })
        return { ok: true }
      }
      case 'type': {
        const ok = await this.page<{ ok?: boolean; error?: string }>(g, `(() => { let el; try { el = document.querySelector(${JSON.stringify(sel)}) } catch (e) { return { error: 'bad' } } if (el === null) return { error: 'missing' }; el.focus(); return { ok: true } })()`)
        if (ok?.ok !== true) throw err('BROWSER_BAD_SELECTOR', 'That selector matches nothing on the page')
        await this.send(g, 'Input.insertText', { text: a['text'] })
        return { ok: true }
      }
      case 'eval': return this.evaluate(g, a['script'] as string)
      default: return null
    }
  }

  private async evaluate(g: GuestLike, script: string): Promise<{ value: unknown }> {
    let res: any
    try {
      res = await this.send(g, 'Runtime.evaluate', { expression: script, awaitPromise: true, returnByValue: true, timeout: 5000 }, 8000)
    } catch (e) {
      if (e instanceof CrossweaveError) throw e
      // A DOM node or a cyclic object cannot be returned by value: the protocol says so as an error.
      if (/by value|serializ|cyclic|reference chain/i.test(String((e as Error)?.message ?? e))) throw err('BROWSER_EVAL_UNSERIALIZABLE', 'The result cannot be sent as data (a DOM node or a cyclic object?)')
      throw err('BROWSER_EVAL_FAILED', 'The page could not run that')
    }
    const ex = res?.exceptionDetails
    if (ex !== undefined) {
      const description = String(ex.exception?.description ?? ex.text ?? 'exception')
      if (/execution was terminated/i.test(description)) throw err('BROWSER_TIMEOUT', 'The script ran too long and was stopped')
      throw err('BROWSER_EVAL_FAILED', clip(description, 500))
    }
    const value = res?.result?.value
    const json = JSON.stringify(value === undefined ? null : value)
    if (json.length > EVAL_RESULT_CAP) throw err('BROWSER_TOO_LARGE', 'The result is over 64 KB')
    return { value: value ?? null }
  }

  private async shot(g: GuestLike, selector: string | undefined, projectRoot: string): Promise<{ path: string }> {
    let clipRect: object | undefined
    if (selector !== undefined) {
      const r = await this.page<{ x?: number; y?: number; width?: number; height?: number; error?: string }>(g, `(() => { let el; try { el = document.querySelector(${JSON.stringify(selector)}) } catch (e) { return { error: 'bad' } } if (el === null) return { error: 'missing' }; const r = el.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height } })()`)
      if (r?.error !== undefined || typeof r?.width !== 'number' || r.width <= 0 || (r.height ?? 0) <= 0) throw err('BROWSER_BAD_SELECTOR', 'That selector matches nothing visible on the page')
      clipRect = { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 }
    }
    const res = await this.send(g, 'Page.captureScreenshot', { format: 'png', ...(clipRect === undefined ? {} : { clip: clipRect }) })
    const b64 = typeof res?.data === 'string' ? res.data : ''
    if (b64 === '') throw err('BROWSER_FAILED', 'The page returned no image')
    if (Math.floor((b64.length * 3) / 4) > SHOT_CAP) throw err('BROWSER_TOO_LARGE', 'The screenshot is over 8 MB')
    const dir = join(projectRoot, '.crossweave', 'shots')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const name = `${String(this.now()).padStart(15, '0')}-${String(this.shotSeq++ % 1000).padStart(3, '0')}.png`
    const path = assertContained(projectRoot, join(dir, name))
    writeFileSync(path, Buffer.from(b64, 'base64'), { mode: 0o600 })
    const old = readdirSync(dir).filter((f) => /^\d{15}-\d{3}\.png$/.test(f)).sort()
    for (const f of old.slice(0, Math.max(0, old.length - SHOTS_KEPT))) unlinkSync(join(dir, f))
    return { path }
  }
}
