import { describe, expect, it } from 'bun:test';
import { FailureLimiter } from '../../src/remote/limiter.js';

describe('failure limiter', () => {
  it('blocks an address after too many failures in the window, then lets it back', () => {
    let t = 0;
    const l = new FailureLimiter({ max: 3, windowMs: 1000, blockMs: 5000, now: () => t });
    expect(l.fail('a')).toBe(false);
    expect(l.fail('a')).toBe(false);
    expect(l.isBlocked('a')).toBe(false);
    expect(l.fail('a')).toBe(true);
    expect(l.isBlocked('a')).toBe(true);
    expect(l.isBlocked('b')).toBe(false);
    t = 5001;
    expect(l.isBlocked('a')).toBe(false);
  });

  it('forgets failures older than the window', () => {
    let t = 0;
    const l = new FailureLimiter({ max: 3, windowMs: 1000, now: () => t });
    l.fail('a');
    l.fail('a');
    t = 1500;
    expect(l.fail('a')).toBe(false);
    expect(l.isBlocked('a')).toBe(false);
  });
});
