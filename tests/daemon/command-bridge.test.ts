import { describe, it, expect } from 'bun:test';
import { BridgeRegistry, type BridgeClock } from '../../src/daemon/bridge-registry.js';
import type { MethodContext } from '../../src/daemon/server.js';

/** A fake cockpit connection: records what the daemon sends it, and can be closed. */
function fakeCtx(): MethodContext & { sent: Array<{ method: string; params: any }>; close(): void; failNotify: boolean } {
  const closers: Array<() => void> = [];
  const ctx = {
    sent: [] as Array<{ method: string; params: any }>,
    failNotify: false,
    notify(method: string, params: unknown) {
      if (ctx.failNotify) throw new Error('socket gone');
      ctx.sent.push({ method, params });
    },
    onClose(cb: () => void) { closers.push(cb); },
    close() { for (const c of closers) c(); },
  };
  return ctx;
}

/** A manual clock: nothing fires until the test advances it. */
function fakeClock(): BridgeClock & { advance(ms: number): void; pendingTimers(): number } {
  let now = 1_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimer(fn, ms) { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer(h) { timers.delete(h as number); },
    pendingTimers: () => timers.size,
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
    },
  };
}

const WS = 'ws_1';
const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try { await p; return 'resolved'; } catch (e) { return (e as { code?: string }).code ?? 'no-code'; }
};

function setup() {
  const clock = fakeClock();
  const bridge = new BridgeRegistry({ clock });
  const ctx = fakeCtx();
  return { bridge, clock, ctx };
}

describe('registration', () => {
  it('a call with no cockpit attached is BRIDGE_NO_COCKPIT', async () => {
    const { bridge } = setup();
    expect(await codeOf(bridge.call(WS, 'pane.ping', {}))).toBe('BRIDGE_NO_COCKPIT');
  });

  it('a second register while one is live is refused, and the first keeps working', async () => {
    const { bridge, ctx } = setup();
    bridge.register(ctx, WS, ['pane.ping']);
    const other = fakeCtx();
    expect(() => bridge.register(other, WS, ['pane.ping'])).toThrow(/already registered/i);
    try { bridge.register(other, WS, ['pane.ping']); } catch (e) { expect((e as { code: string }).code).toBe('BRIDGE_ALREADY_REGISTERED'); }
    const call = bridge.call(WS, 'pane.ping', {});
    const req = ctx.sent[0]!;
    bridge.respond(ctx, req.params.id, { ok: true, result: 'pong' });
    expect(await call).toBe('pong');
    expect(other.sent).toEqual([]); // the loser never received a request
  });

  it('a registration ends when its connection closes, and the slot is free again', async () => {
    const { bridge, ctx } = setup();
    bridge.register(ctx, WS, ['pane.ping']);
    ctx.close();
    expect(await codeOf(bridge.call(WS, 'pane.ping', {}))).toBe('BRIDGE_NO_COCKPIT');
    const again = fakeCtx();
    expect(() => bridge.register(again, WS, ['pane.ping'])).not.toThrow();
  });

  it('a stale close of an old connection never removes a newer registration', async () => {
    const { bridge, ctx } = setup();
    bridge.register(ctx, WS, ['pane.ping']);
    ctx.close();
    const next = fakeCtx();
    bridge.register(next, WS, ['pane.ping']);
    ctx.close(); // the first connection reports closing again
    const call = bridge.call(WS, 'pane.ping', {});
    expect(next.sent).toHaveLength(1);
    bridge.respond(next, next.sent[0]!.params.id, { ok: true, result: 1 });
    expect(await call).toBe(1);
  });

  it('refuses kinds outside the daemon\'s closed list of namespaces, or malformed', () => {
    const { bridge } = setup();
    for (const kinds of [['evil.run'], ['pane'], ['pane.'], ['Pane.ping'], ['pane.ping; rm']]) {
      const ctx = fakeCtx();
      expect(() => bridge.register(ctx, WS, kinds)).toThrow();
    }
  });
});

describe('calls', () => {
  it('a round trip returns the cockpit\'s result and sends the daemon-made id, kind and params', async () => {
    const { bridge, ctx } = setup();
    bridge.register(ctx, WS, ['pane.ping']);
    const call = bridge.call(WS, 'pane.ping', { a: 1 });
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]!.method).toBe('bridge.request');
    expect(ctx.sent[0]!.params).toMatchObject({ kind: 'pane.ping', params: { a: 1 } });
    expect(String(ctx.sent[0]!.params.id).length).toBeGreaterThan(8);
    bridge.respond(ctx, ctx.sent[0]!.params.id, { ok: true, result: { pong: true } });
    expect(await call).toEqual({ pong: true });
  });

  it('an unknown namespace is BRIDGE_UNKNOWN_KIND before anything is sent', async () => {
    const { bridge, ctx } = setup();
    bridge.register(ctx, WS, ['pane.ping']);
    expect(await codeOf(bridge.call(WS, 'evil.run', {}))).toBe('BRIDGE_UNKNOWN_KIND');
    expect(await codeOf(bridge.call(WS, 'nonsense', {}))).toBe('BRIDGE_UNKNOWN_KIND');
    expect(ctx.sent).toEqual([]);
  });

  it('a known namespace whose kind the cockpit did not register is BRIDGE_UNSUPPORTED_KIND', async () => {
    const { bridge, ctx } = setup();
    bridge.register(ctx, WS, ['pane.ping']);
    expect(await codeOf(bridge.call(WS, 'pane.split', {}))).toBe('BRIDGE_UNSUPPORTED_KIND');
    expect(ctx.sent).toEqual([]);
  });

  it('the first respond settles; any later one is ignored', async () => {
    const { bridge, ctx } = setup();
    bridge.register(ctx, WS, ['pane.ping']);
    const call = bridge.call(WS, 'pane.ping', {});
    const id = ctx.sent[0]!.params.id;
    bridge.respond(ctx, id, { ok: true, result: 'first' });
    bridge.respond(ctx, id, { ok: true, result: 'second' });
    expect(await call).toBe('first');
  });

  it('a respond from a connection that was not the addressee is ignored', async () => {
    const { bridge, ctx } = setup();
    bridge.register(ctx, WS, ['pane.ping']);
    const call = bridge.call(WS, 'pane.ping', {});
    const id = ctx.sent[0]!.params.id;
    const stranger = fakeCtx();
    bridge.respond(stranger, id, { ok: true, result: 'forged' });
    bridge.respond(ctx, id, { ok: true, result: 'real' });
    expect(await call).toBe('real');
  });

  it('a cockpit error keeps its code and message; a malformed code becomes BRIDGE_HANDLER_FAILED', async () => {
    const { bridge, ctx } = setup();
    bridge.register(ctx, WS, ['pane.ping']);
    const a = bridge.call(WS, 'pane.ping', {});
    bridge.respond(ctx, ctx.sent[0]!.params.id, { ok: false, code: 'PANE_NOT_FOUND', message: 'no such pane' });
    await expect(a).rejects.toMatchObject({ code: 'PANE_NOT_FOUND', message: 'no such pane' });
    const b = bridge.call(WS, 'pane.ping', {});
    bridge.respond(ctx, ctx.sent[1]!.params.id, { ok: false, code: 'bad code!', message: 'x' });
    await expect(b).rejects.toMatchObject({ code: 'BRIDGE_HANDLER_FAILED' });
  });

  it('a notify that throws fails the call as detached and leaves no waiter', async () => {
    const { bridge, ctx, clock } = setup();
    bridge.register(ctx, WS, ['pane.ping']);
    ctx.failNotify = true;
    expect(await codeOf(bridge.call(WS, 'pane.ping', {}))).toBe('BRIDGE_DETACHED');
    expect(clock.pendingTimers()).toBe(0);
  });
});

describe('timeouts', () => {
  it('expiry rejects with BRIDGE_TIMEOUT, frees the waiter, and a late response is ignored', async () => {
    const { bridge, ctx, clock } = setup();
    bridge.register(ctx, WS, ['pane.ping']);
    const call = bridge.call(WS, 'pane.ping', {}, 2000);
    const id = ctx.sent[0]!.params.id;
    clock.advance(2000);
    expect(await codeOf(call)).toBe('BRIDGE_TIMEOUT');
    expect(clock.pendingTimers()).toBe(0);
    expect(() => bridge.respond(ctx, id, { ok: true, result: 'late' })).not.toThrow();
  });

  it('the default is 10 s; 0, negative and non-numbers never mean "forever"', async () => {
    const { bridge, ctx, clock } = setup();
    bridge.register(ctx, WS, ['pane.ping']);
    const a = bridge.call(WS, 'pane.ping', {});
    clock.advance(9_999);
    let settled = false;
    void codeOf(a).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    clock.advance(1);
    expect(await codeOf(a)).toBe('BRIDGE_TIMEOUT');

    for (const bad of [0, -5, Number.NaN, 'x' as unknown as number]) {
      const call = bridge.call(WS, 'pane.ping', {}, bad);
      clock.advance(60_000);
      expect(await codeOf(call)).toBe('BRIDGE_TIMEOUT');
    }
  });

  it('is clamped to at least 1 s and at most 60 s', async () => {
    const { bridge, ctx, clock } = setup();
    bridge.register(ctx, WS, ['pane.ping']);
    const tiny = bridge.call(WS, 'pane.ping', {}, 5);
    clock.advance(999);
    let tinySettled = false;
    void codeOf(tiny).then(() => { tinySettled = true; });
    await Promise.resolve();
    expect(tinySettled).toBe(false); // the floor is 1 s
    clock.advance(1);
    expect(await codeOf(tiny)).toBe('BRIDGE_TIMEOUT');

    const huge = bridge.call(WS, 'pane.ping', {}, 10 * 60_000);
    clock.advance(60_000);
    expect(await codeOf(huge)).toBe('BRIDGE_TIMEOUT'); // the ceiling is 60 s
  });
});

describe('detach', () => {
  it('closing the connection rejects every pending call with BRIDGE_DETACHED and empties the map', async () => {
    const { bridge, ctx, clock } = setup();
    bridge.register(ctx, WS, ['pane.ping']);
    const a = bridge.call(WS, 'pane.ping', {});
    const b = bridge.call(WS, 'pane.ping', {});
    ctx.close();
    expect(await codeOf(a)).toBe('BRIDGE_DETACHED');
    expect(await codeOf(b)).toBe('BRIDGE_DETACHED');
    expect(clock.pendingTimers()).toBe(0);
    expect(bridge.inFlight(WS)).toBe(0);
  });
});

describe('caps', () => {
  it('at most 8 requests in flight per registration: the ninth is BRIDGE_BUSY', async () => {
    const { bridge, ctx } = setup();
    bridge.register(ctx, WS, ['pane.ping']);
    const open = Array.from({ length: 8 }, () => bridge.call(WS, 'pane.ping', {}));
    expect(await codeOf(bridge.call(WS, 'pane.ping', {}))).toBe('BRIDGE_BUSY');
    bridge.respond(ctx, ctx.sent[0]!.params.id, { ok: true, result: 1 });
    await open[0];
    // a slot freed up: one more is accepted
    const again = bridge.call(WS, 'pane.ping', {});
    expect(ctx.sent).toHaveLength(9);
    ctx.close();
    await Promise.all([...open.slice(1), again].map((p) => codeOf(p)));
  });

  it('at most 20 calls a second per registration', async () => {
    const { bridge, ctx, clock } = setup();
    bridge.register(ctx, WS, ['pane.ping']);
    const codes: string[] = [];
    for (let i = 0; i < 25; i++) {
      const p = bridge.call(WS, 'pane.ping', {});
      bridge.respond(ctx, ctx.sent[ctx.sent.length - 1]?.params.id, { ok: true, result: i });
      codes.push(await codeOf(p));
    }
    expect(codes.filter((c) => c === 'resolved')).toHaveLength(20);
    expect(codes.filter((c) => c === 'BRIDGE_BUSY')).toHaveLength(5);
    clock.advance(1000);
    const p = bridge.call(WS, 'pane.ping', {});
    bridge.respond(ctx, ctx.sent[ctx.sent.length - 1]!.params.id, { ok: true, result: 'later' });
    expect(await p).toBe('later'); // the window slid
  });

  it('params over 8 MB are BRIDGE_TOO_LARGE and never sent; so is an oversized response', async () => {
    const { bridge, ctx } = setup();
    bridge.register(ctx, WS, ['pane.ping']);
    const big = 'x'.repeat(8 * 1024 * 1024 + 1);
    expect(await codeOf(bridge.call(WS, 'pane.ping', { big }))).toBe('BRIDGE_TOO_LARGE');
    expect(ctx.sent).toEqual([]);
    const call = bridge.call(WS, 'pane.ping', {});
    bridge.respond(ctx, ctx.sent[0]!.params.id, { ok: true, result: big });
    expect(await codeOf(call)).toBe('BRIDGE_TOO_LARGE');
  });
});
