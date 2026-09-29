/** Time source, injected so the coalescer is deterministic under test. */
export interface CoalescerClock {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

const REAL_CLOCK: CoalescerClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** One pty chunk is often a few bytes; a burst is hundreds. 4 ms is under a frame. */
const DEFAULT_WINDOW_MS = 4;
/** Flush early past this, so a firehose cannot grow one message without bound. */
const DEFAULT_CAP_BYTES = 256 * 1024;

interface Pending {
  buf: string;
  timer: unknown;
  lastFlush: number;
}

export interface OutputCoalescerOptions<S> {
  /** Deliver one merged chunk. A throw is the subscriber's failure, not the stream's. */
  send: (subscriber: S, chunk: string) => void;
  windowMs?: number;
  capBytes?: number;
  clock?: CoalescerClock;
}

/**
 * Merges a burst of pty output into fewer notifications, per subscriber, in order.
 *
 * The first chunk after a quiet window goes out at once (leading edge), so an
 * interactive echo pays no added latency; only a burst waits, at most one window.
 * This is not backpressure: it trims message overhead, it does not slow the source.
 *
 * Each subscriber has its own buffer because subscribers attach at different times: a
 * shared buffer would hand a late joiner bytes its scrollback replay already carries.
 */
export class OutputCoalescer<S> {
  private readonly state = new Map<S, Pending>();
  private readonly windowMs: number;
  private readonly capBytes: number;
  private readonly clock: CoalescerClock;

  constructor(private readonly opts: OutputCoalescerOptions<S>) {
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.capBytes = opts.capBytes ?? DEFAULT_CAP_BYTES;
    this.clock = opts.clock ?? REAL_CLOCK;
  }

  push(subscriber: S, chunk: string): void {
    let p = this.state.get(subscriber);
    if (p === undefined) {
      p = { buf: '', timer: undefined, lastFlush: Number.NEGATIVE_INFINITY };
      this.state.set(subscriber, p);
    }
    const idle = p.buf === '' && this.clock.now() - p.lastFlush >= this.windowMs;
    p.buf += chunk;
    if (idle || p.buf.length > this.capBytes) {
      this.flush(subscriber, p);
      return;
    }
    if (p.timer === undefined) {
      const wait = Math.max(0, p.lastFlush + this.windowMs - this.clock.now());
      p.timer = this.clock.setTimer(() => this.flush(subscriber, p), wait);
    }
  }

  /**
   * Forget a subscriber's pending output. Called on every subscribe — a new one or the
   * same connection attaching again — because the scrollback replay that follows
   * already contains whatever was pending, and a timer flush after it would print it
   * twice. Also called when the subscriber closes: there is no one to deliver to.
   */
  clear(subscriber: S): void {
    const p = this.state.get(subscriber);
    if (p === undefined) return;
    if (p.timer !== undefined) this.clock.clearTimer(p.timer);
    this.state.delete(subscriber);
  }

  /** Deliver everything pending now — before an exit notification, so no output is lost. */
  flushAll(): void {
    for (const [subscriber, p] of [...this.state]) this.flush(subscriber, p);
  }

  private flush(subscriber: S, p: Pending): void {
    if (p.timer !== undefined) this.clock.clearTimer(p.timer);
    p.timer = undefined;
    const chunk = p.buf;
    p.buf = '';
    p.lastFlush = this.clock.now();
    if (chunk === '') return;
    try {
      this.opts.send(subscriber, chunk);
    } catch {
      // The subscriber owns its failure; the other subscribers' streams keep going.
    }
  }
}
