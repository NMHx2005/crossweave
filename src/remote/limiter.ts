/**
 * Failures per client address: a bad pairing code, a bad device token, a refused
 * origin. Past `max` within `windowMs` the address is shut out for `blockMs` — every
 * request and socket, not only the kind that failed. Tokens and codes are out of
 * guessing range already; this keeps a noisy neighbour on the Wi-Fi from spending the
 * Mac's time, and makes a scan visible in the audit log rather than endless.
 */
export class FailureLimiter {
  private readonly failures = new Map<string, number[]>();
  private readonly blocked = new Map<string, number>();

  constructor(private readonly opts: { max?: number; windowMs?: number; blockMs?: number; now?: () => number } = {}) {}

  private get now(): number {
    return (this.opts.now ?? Date.now)();
  }

  isBlocked(address: string): boolean {
    const until = this.blocked.get(address);
    if (until === undefined) return false;
    if (this.now < until) return true;
    this.blocked.delete(address);
    return false;
  }

  /** Record one failure; true when this one blocked the address. */
  fail(address: string): boolean {
    const now = this.now;
    const windowMs = this.opts.windowMs ?? 300_000;
    const recent = (this.failures.get(address) ?? []).filter((t) => now - t < windowMs);
    recent.push(now);
    if (recent.length >= (this.opts.max ?? 10)) {
      this.failures.delete(address);
      this.blocked.set(address, now + (this.opts.blockMs ?? 300_000));
      return true;
    }
    this.failures.set(address, recent);
    return false;
  }
}
