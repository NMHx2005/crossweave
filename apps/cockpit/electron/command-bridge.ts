import { CrossweaveError } from '../../../src/core/errors.js'

export type BridgeContext = { projectRoot: string; workspaceId: string }
export type BridgeHandler = (params: unknown, ctx: BridgeContext) => unknown | Promise<unknown>
export type BridgeRequest = { id: string; kind: string; params: unknown }
export type BridgeAnswer =
  | { ok: true; result: unknown }
  | { ok: false; code: string; message: string }

/**
 * What the running cockpit will do when a shell command asks (through the daemon's
 * bridge). A kind is served only if a handler was registered for it here; the daemon carries
 * the request and decides nothing, so THIS is where a kind's own permission checks live.
 *
 * Fail closed: a handler that throws anything but a CrossweaveError yields
 * BRIDGE_HANDLER_FAILED with a fixed sentence — no stack, no path, no message from the error —
 * because the caller may be an agent that was prompt-injected.
 */
export class CommandBridgeServer {
  private readonly handlers = new Map<string, BridgeHandler>()

  serve(kind: string, handler: BridgeHandler): void {
    if (this.handlers.has(kind)) throw new Error(`Bridge kind already served: ${kind}`)
    this.handlers.set(kind, handler)
  }

  kinds(): string[] {
    return [...this.handlers.keys()]
  }

  async handle(request: BridgeRequest, ctx: BridgeContext): Promise<BridgeAnswer> {
    const handler = this.handlers.get(request.kind)
    if (handler === undefined) return { ok: false, code: 'BRIDGE_UNSUPPORTED_KIND', message: `The cockpit does not serve ${request.kind}` }
    try {
      return { ok: true, result: await handler(request.params, ctx) }
    } catch (err) {
      if (err instanceof CrossweaveError) return { ok: false, code: err.code, message: err.message }
      return { ok: false, code: 'BRIDGE_HANDLER_FAILED', message: 'The cockpit could not do that' }
    }
  }
}
