import { CrossweaveError } from '../core/errors.js';
import { newId } from '../core/ids.js';
import type { MethodContext } from './server.js';

/** Time source, injected so timeouts and the rate window are deterministic under test. */
export interface BridgeClock {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

const REAL_CLOCK: BridgeClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * The namespaces a kind may live in. Adding one is a change to THIS list, in the daemon:
 * a client cannot widen what the bridge will carry.
 */
export const BRIDGE_NAMESPACES: ReadonlySet<string> = new Set(['pane', 'browser']);

const KIND = /^([a-z]+)\.([a-z][A-Za-z0-9]*)$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{2,39}$/;

const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_IN_FLIGHT = 8;
const MAX_CALLS_PER_SECOND = 20;
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 500;

interface Waiter {
  resolve: (value: unknown) => void;
  reject: (err: CrossweaveError) => void;
  timer: unknown;
}

interface Registration {
  ctx: MethodContext;
  kinds: ReadonlySet<string>;
  pending: Map<string, Waiter>;
  /** Times of recent calls, for the per-second cap. */
  recent: number[];
}

export type BridgeResponse =
  | { ok: true; result?: unknown }
  | { ok: false; code?: unknown; message?: unknown };

/**
 * Lets a shell command make the running cockpit do something and get an answer. The daemon
 * only carries the envelope: it never looks inside `params` or `result`, and it grants
 * nothing — the caller is unauthenticated (anything running as the user reaches the socket),
 * so who may ask for what is decided per kind in the cockpit.
 *
 * In memory only: nothing survives a daemon restart, and nothing is written anywhere.
 */
export class BridgeRegistry {
  private readonly registrations = new Map<string, Registration>();
  private readonly clock: BridgeClock;

  constructor(opts: { clock?: BridgeClock } = {}) {
    this.clock = opts.clock ?? REAL_CLOCK;
  }

  /** The kinds a cockpit serves, for one workspace; first come, first served. */
  register(ctx: MethodContext, workspaceId: string, kinds: readonly string[]): void {
    if (!Array.isArray(kinds) || kinds.length > 64) {
      throw new CrossweaveError('BRIDGE_UNKNOWN_KIND', 'kinds must be a short list of <namespace>.<verb> names');
    }
    for (const kind of kinds) this.assertKnownKind(kind);
    // Refused, never replaced: "newest wins" would let any process running as the user
    // register and take the live cockpit's requests, forge its answers or starve it.
    if (this.registrations.has(workspaceId)) {
      throw new CrossweaveError('BRIDGE_ALREADY_REGISTERED', 'Another client is already registered on this workspace');
    }
    const registration: Registration = { ctx, kinds: new Set(kinds), pending: new Map(), recent: [] };
    this.registrations.set(workspaceId, registration);
    ctx.onClose(() => {
      // Only this registration: a stale close must not remove a newer one.
      if (this.registrations.get(workspaceId) !== registration) return;
      this.registrations.delete(workspaceId);
      for (const [id, waiter] of [...registration.pending]) {
        registration.pending.delete(id);
        this.clock.clearTimer(waiter.timer);
        waiter.reject(new CrossweaveError('BRIDGE_DETACHED', 'The cockpit disconnected'));
      }
    });
  }

  /** A shell command's request: forwarded to the registered cockpit, answered or failed. */
  call(workspaceId: string, kind: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    try {
      return this.start(workspaceId, kind, params, timeoutMs);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /** The cockpit's answer. Ignored unless `ctx` is the connection that was asked. */
  respond(ctx: MethodContext, id: string, response: BridgeResponse): void {
    for (const registration of this.registrations.values()) {
      if (registration.ctx !== ctx) continue;
      const waiter = registration.pending.get(id);
      // Unknown, already answered, or timed out: the first answer won, the rest are noise.
      if (waiter === undefined) return;
      registration.pending.delete(id);
      this.clock.clearTimer(waiter.timer);
      if (response?.ok === true) {
        if (sizeOf(response.result) > MAX_PAYLOAD_BYTES) waiter.reject(new CrossweaveError('BRIDGE_TOO_LARGE', 'The cockpit\'s response is too large'));
        else waiter.resolve(response.result);
        return;
      }
      const code = typeof response?.code === 'string' && ERROR_CODE.test(response.code) ? response.code : 'BRIDGE_HANDLER_FAILED';
      const message = typeof response?.message === 'string' ? response.message.slice(0, MAX_MESSAGE_CHARS) : 'The cockpit could not do that';
      waiter.reject(new CrossweaveError(code, message));
      return;
    }
  }

  /** Requests waiting for an answer in a workspace (tests, diagnostics). */
  inFlight(workspaceId: string): number {
    return this.registrations.get(workspaceId)?.pending.size ?? 0;
  }

  private assertKnownKind(kind: string): void {
    const m = typeof kind === 'string' ? KIND.exec(kind) : null;
    if (m === null || !BRIDGE_NAMESPACES.has(m[1] as string)) {
      throw new CrossweaveError('BRIDGE_UNKNOWN_KIND', `Unknown request kind: ${String(kind).slice(0, 60)}`);
    }
  }

  private start(workspaceId: string, kind: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    // Before anything is sent, and before "is there a cockpit": a bad kind is the caller's mistake.
    this.assertKnownKind(kind);
    const registration = this.registrations.get(workspaceId);
    if (registration === undefined) throw new CrossweaveError('BRIDGE_NO_COCKPIT', 'No cockpit is attached to this workspace');
    if (!registration.kinds.has(kind)) throw new CrossweaveError('BRIDGE_UNSUPPORTED_KIND', `The cockpit does not serve ${kind}`);
    if (sizeOf(params) > MAX_PAYLOAD_BYTES) throw new CrossweaveError('BRIDGE_TOO_LARGE', 'The request is too large');

    const now = this.clock.now();
    registration.recent = registration.recent.filter((t) => now - t < 1000);
    if (registration.pending.size >= MAX_IN_FLIGHT || registration.recent.length >= MAX_CALLS_PER_SECOND) {
      throw new CrossweaveError('BRIDGE_BUSY', 'The cockpit is busy; try again in a moment');
    }
    registration.recent.push(now);

    // Never "wait forever": 0, negative, NaN and non-numbers fall back to the default,
    // and anything else is held between the floor and the ceiling.
    const asked = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    const timeout = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, asked));

    // Made here, unguessable, so a cockpit can only answer what it was actually asked.
    const id = newId('br');
    return new Promise<unknown>((resolve, reject) => {
      const timer = this.clock.setTimer(() => {
        registration.pending.delete(id);
        reject(new CrossweaveError('BRIDGE_TIMEOUT', `The cockpit did not answer ${kind} in time`));
      }, timeout);
      registration.pending.set(id, { resolve, reject, timer });
      try {
        registration.ctx.notify('bridge.request', { id, kind, params });
      } catch {
        registration.pending.delete(id);
        this.clock.clearTimer(timer);
        reject(new CrossweaveError('BRIDGE_DETACHED', 'The cockpit is no longer reachable'));
      }
    });
  }
}

function sizeOf(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
