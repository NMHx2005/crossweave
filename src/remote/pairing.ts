import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The one-time code that turns a phone into a paired device. Shown only on the Mac
 * (Settings, or `cw remote serve --pair`), so knowing it proves the person pairing can
 * see this screen. 10 letters of 32 = 50 bits, alive for 2 minutes, burned by its
 * first use or its fifth wrong guess: guessing it is out of reach even before the
 * server's per-address limits.
 */

/** No 0/O or 1/I: the code may be typed from the screen. 32 letters, so a byte's low 5 bits pick one without bias. */
export const PAIR_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const LENGTH = 10;
const TTL_MS = 120_000;
const TRIES = 5;

export type RedeemResult = 'ok' | 'wrong' | 'burned' | 'expired' | 'none';

/** As the Mac shows it: two groups of five. */
export function formatCode(code: string): string {
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

export class Pairing {
  private live: { code: string; expiresAt: number; triesLeft: number } | undefined;
  private readonly now: () => number;
  private readonly random: (n: number) => Uint8Array;

  constructor(opts: { now?: () => number; random?: (n: number) => Uint8Array } = {}) {
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? ((n) => randomBytes(n));
  }

  start(): { code: string; expiresAt: number } {
    const bytes = this.random(LENGTH);
    const code = Array.from(bytes, (b) => PAIR_ALPHABET[b & 31]).join('');
    this.live = { code, expiresAt: this.now() + TTL_MS, triesLeft: TRIES };
    return { code, expiresAt: this.live.expiresAt };
  }

  cancel(): void {
    this.live = undefined;
  }

  current(): { code: string; expiresAt: number } | undefined {
    if (this.live !== undefined && this.now() > this.live.expiresAt) this.live = undefined;
    return this.live === undefined ? undefined : { code: this.live.code, expiresAt: this.live.expiresAt };
  }

  redeem(presented: unknown): RedeemResult {
    const live = this.live;
    if (live === undefined) return 'none';
    if (this.now() > live.expiresAt) {
      this.live = undefined;
      return 'expired';
    }
    const normal = typeof presented === 'string' && presented.length <= 64
      ? presented.toUpperCase().replace(/[\s-]/g, '')
      : '';
    const ok = normal.length === LENGTH && timingSafeEqual(Buffer.from(normal), Buffer.from(live.code));
    if (ok) {
      this.live = undefined;
      return 'ok';
    }
    live.triesLeft -= 1;
    if (live.triesLeft > 0) return 'wrong';
    this.live = undefined;
    return 'burned';
  }
}
