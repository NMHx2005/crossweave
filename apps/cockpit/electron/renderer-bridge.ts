import { randomUUID } from 'node:crypto'
import { CrossweaveError } from '../../../src/core/errors.js'

const ERROR_CODE = /^[A-Z][A-Z0-9_]{2,39}$/
const DEFAULT_TIMEOUT_MS = 50_000

interface Waiter {
  resolve: (value: unknown) => void
  reject: (err: CrossweaveError) => void
  timer: ReturnType<typeof setTimeout>
}

export interface RendererBridgeDeps {
  /** Deliver an event to the window; false when there is none to receive it. */
  send: (event: 'cockpit.bridge', payload: unknown) => boolean
  timeoutMs?: number
  newId?: () => string
}

/**
 * The hop from the main process to the window for a bridge request that only the renderer can
 * carry out (the layout lives there). Main asks with an id IT made; the renderer answers on the
 * `bridge.reply` channel; only an id main issued, and only once, settles a request. No window, or no
 * answer within the timeout, is an error — a request is never parked for later.
 */
export class RendererBridge {
  private readonly waiting = new Map<string, Waiter>()

  constructor(private readonly deps: RendererBridgeDeps) {}

  pending(): number {
    return this.waiting.size
  }

  ask(kind: string, params: unknown, ctx: { projectRoot: string }): Promise<unknown> {
    const id = (this.deps.newId ?? randomUUID)()
    return new Promise<unknown>((resolve, reject) => {
      if (!this.deps.send('cockpit.bridge', { id, kind, params, projectRoot: ctx.projectRoot })) {
        reject(new CrossweaveError('BRIDGE_NO_WINDOW', 'The cockpit has no window open'))
        return
      }
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new CrossweaveError('BRIDGE_TIMEOUT', `The window did not answer ${kind} in time`))
      }, this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      this.waiting.set(id, { resolve, reject, timer })
    })
  }

  /** The renderer's answer, from the `bridge.reply` channel. Whatever else it says is ignored. */
  reply(payload: unknown): void {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return
    const r = payload as { id?: unknown; ok?: unknown; result?: unknown; code?: unknown; message?: unknown }
    if (typeof r.id !== 'string') return
    const waiter = this.waiting.get(r.id)
    if (waiter === undefined) return
    this.waiting.delete(r.id)
    clearTimeout(waiter.timer)
    if (r.ok === true) {
      waiter.resolve(r.result)
      return
    }
    if (typeof r.code === 'string' && ERROR_CODE.test(r.code)) {
      waiter.reject(new CrossweaveError(r.code, typeof r.message === 'string' ? r.message.slice(0, 500) : 'The window could not do that'))
    } else {
      waiter.reject(new CrossweaveError('BRIDGE_HANDLER_FAILED', 'The window could not do that'))
    }
  }
}
