import { describe, it, expect } from 'bun:test';
import { OutputCoalescer, type CoalescerClock } from '../../src/daemon/output-coalescer.js';

/** A manual clock: nothing fires until the test advances it. */
function fakeClock(): CoalescerClock & { advance(ms: number): void } {
  let now = 1_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimer(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer(handle) {
      timers.delete(handle as number);
    },
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

type Ctx = { name: string };
const A: Ctx = { name: 'a' };
const B: Ctx = { name: 'b' };

function setup(opts: { windowMs?: number; capBytes?: number } = {}) {
  const clock = fakeClock();
  const sent: Array<[string, string]> = [];
  const c = new OutputCoalescer<Ctx>({ send: (ctx, chunk) => sent.push([ctx.name, chunk]), clock, ...opts });
  return { c, clock, sent };
}

describe('OutputCoalescer', () => {
  it('sends the first chunk at once when idle: an echo pays no added latency', () => {
    const { c, sent } = setup();
    c.push(A, 'x');
    expect(sent).toEqual([['a', 'x']]);
  });

  it('coalesces a burst into one send, in order, when the window elapses', () => {
    const { c, clock, sent } = setup({ windowMs: 4 });
    c.push(A, '1'); // leading edge
    c.push(A, '2');
    c.push(A, '3');
    expect(sent).toEqual([['a', '1']]);
    clock.advance(4);
    expect(sent).toEqual([['a', '1'], ['a', '23']]);
  });

  it('is idle again after a quiet window: the next chunk is immediate', () => {
    const { c, clock, sent } = setup({ windowMs: 4 });
    c.push(A, '1');
    clock.advance(10);
    c.push(A, '2');
    expect(sent).toEqual([['a', '1'], ['a', '2']]);
  });

  it('flushes early once a buffer passes the cap', () => {
    const { c, sent } = setup({ windowMs: 4, capBytes: 5 });
    c.push(A, 'a'); // leading edge
    c.push(A, '123');
    expect(sent).toEqual([['a', 'a']]);
    c.push(A, '456'); // 6 > 5
    expect(sent).toEqual([['a', 'a'], ['a', '123456']]);
  });

  it('keeps a buffer per subscriber', () => {
    const { c, clock, sent } = setup({ windowMs: 4 });
    c.push(A, '1');
    c.push(A, '2');
    c.push(B, 'x'); // B is idle: immediate, and A's pending chunk is not B's
    expect(sent).toEqual([['a', '1'], ['b', 'x']]);
    clock.advance(4);
    expect(sent).toEqual([['a', '1'], ['b', 'x'], ['a', '2']]);
  });

  it('flushAll delivers every pending chunk, so output before an exit is not lost', () => {
    const { c, clock, sent } = setup({ windowMs: 4 });
    c.push(A, '1');
    c.push(A, '2');
    c.push(B, 'x');
    c.push(B, 'y');
    c.flushAll();
    expect(sent).toEqual([['a', '1'], ['b', 'x'], ['a', '2'], ['b', 'y']]);
    clock.advance(50);
    expect(sent.length).toBe(4); // and the timers are gone: no second delivery
  });

  it('clear drops a pending chunk and cancels its timer: a subscribe replay already contains it', () => {
    const { c, clock, sent } = setup({ windowMs: 4 });
    c.push(A, '1');
    c.push(A, 'pending');
    c.clear(A); // re-attach: the replay carries "pending", so it must not arrive again
    clock.advance(50);
    expect(sent).toEqual([['a', '1']]);
  });

  it('after clear the subscriber starts fresh: the next chunk is immediate', () => {
    const { c, sent } = setup({ windowMs: 4 });
    c.push(A, '1');
    c.push(A, 'pending');
    c.clear(A);
    c.push(A, '2');
    expect(sent).toEqual([['a', '1'], ['a', '2']]);
  });

  it('a send that throws does not lose the chunk of another subscriber', () => {
    const clock = fakeClock();
    const got: string[] = [];
    const c = new OutputCoalescer<Ctx>({
      send: (ctx, chunk) => {
        if (ctx === A) throw new Error('gone');
        got.push(chunk);
      },
      clock,
    });
    expect(() => c.push(A, '1')).not.toThrow();
    c.push(B, 'x');
    expect(got).toEqual(['x']);
  });
});
