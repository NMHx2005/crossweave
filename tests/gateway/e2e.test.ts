import { describe, it, expect } from 'bun:test';
import { deriveKey, encrypt, decrypt } from '../../src/gateway/e2e.js';

describe('gateway e2e', () => {
  it('round-trip', () => {
    const k = deriveKey('tok123', 'ws1');
    const blob = encrypt('hello world', k);
    expect(decrypt(blob, k)).toBe('hello world');
  });
  it('different key fails', () => {
    const k1 = deriveKey('tok', 'ws1');
    const k2 = deriveKey('tok', 'ws2');
    const blob = encrypt('secret', k1);
    expect(() => decrypt(blob, k2)).toThrow();
  });
  it('empty string round-trip', () => {
    const k = deriveKey('tok', 'ws1');
    const blob = encrypt('', k);
    expect(decrypt(blob, k)).toBe('');
  });
  it('deriveKey is deterministic', () => {
    const a = deriveKey('tok', 'ws1');
    const b = deriveKey('tok', 'ws1');
    expect(a.toString('hex')).toBe(b.toString('hex'));
  });
});
