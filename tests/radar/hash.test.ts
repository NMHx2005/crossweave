import { describe, expect, test } from 'bun:test';
import { normalizeAndHash } from '../../src/radar/hash.js';

describe('normalizeAndHash', () => {
  test('two functions differing only in whitespace hash the same', () => {
    const a = 'function foo() {\n  return 1;\n}';
    const b = 'function foo() {\n    return 1;\n}\n\n';
    expect(normalizeAndHash(a)).toBe(normalizeAndHash(b));
  });

  test('two functions differing only in a // comment hash the same', () => {
    const a = 'function foo() {\n  return 1;\n}';
    const b = 'function foo() {\n  // note\n  return 1;\n}';
    expect(normalizeAndHash(a)).toBe(normalizeAndHash(b));
  });

  test('a real content change hashes differently', () => {
    const a = 'function foo() {\n  return 1;\n}';
    const b = 'function foo() {\n  return 2;\n}';
    expect(normalizeAndHash(a)).not.toBe(normalizeAndHash(b));
  });
});
