import { describe, expect, it } from 'bun:test';
import { Pairing, PAIR_ALPHABET, formatCode } from '../../src/remote/pairing.js';

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('pairing codes', () => {
  it('makes a 10-letter code from an alphabet with no look-alikes', () => {
    const p = new Pairing();
    const { code } = p.start();
    expect(code).toHaveLength(10);
    for (const ch of code) expect(PAIR_ALPHABET).toContain(ch);
    expect(PAIR_ALPHABET).not.toMatch(/[01OI]/);
    expect(PAIR_ALPHABET).toHaveLength(32);
  });

  it('accepts the code once', () => {
    const p = new Pairing();
    const { code } = p.start();
    expect(p.redeem(code)).toBe('ok');
    expect(p.redeem(code)).toBe('none');
    expect(p.current()).toBeUndefined();
  });

  it('forgives case, spaces and the dash it is shown with', () => {
    const p = new Pairing();
    const { code } = p.start();
    expect(p.redeem(` ${formatCode(code).toLowerCase()} `)).toBe('ok');
  });

  it('expires after two minutes', () => {
    const c = clock();
    const p = new Pairing({ now: c.now });
    const { code, expiresAt } = p.start();
    expect(expiresAt).toBe(120_000);
    c.advance(120_001);
    expect(p.redeem(code)).toBe('expired');
    expect(p.current()).toBeUndefined();
  });

  it('burns the code after five wrong tries', () => {
    const p = new Pairing();
    const { code } = p.start();
    for (let i = 0; i < 4; i++) expect(p.redeem('ZZZZZZZZZZ')).toBe('wrong');
    expect(p.redeem('ZZZZZZZZZZ')).toBe('burned');
    expect(p.redeem(code)).toBe('none');
  });

  it('counts a malformed try as a wrong one', () => {
    const p = new Pairing();
    p.start();
    for (const bad of [undefined, 12, 'short', 'x'.repeat(500)]) expect(p.redeem(bad)).toBe('wrong');
    expect(p.redeem('')).toBe('burned');
  });

  it('keeps one code at a time: a new one replaces the old', () => {
    const p = new Pairing();
    const first = p.start().code;
    const second = p.start().code;
    expect(p.redeem(first)).toBe(first === second ? 'ok' : 'wrong');
    expect(p.redeem(second)).toBe(first === second ? 'none' : 'ok');
  });

  it('can be cancelled', () => {
    const p = new Pairing();
    const { code } = p.start();
    p.cancel();
    expect(p.redeem(code)).toBe('none');
  });

  it('draws every letter uniformly from the random source', () => {
    const p = new Pairing({ random: (n) => Uint8Array.from({ length: n }, (_, i) => i * 37) });
    expect(p.start().code).toBe(Array.from({ length: 10 }, (_, i) => PAIR_ALPHABET[(i * 37) & 31]).join(''));
  });
});
