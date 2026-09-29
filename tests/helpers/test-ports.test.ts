import { describe, it, expect } from 'bun:test';
import { TEST_CONFIG, testPortBase } from './test-ports.js';

describe('testPortBase', () => {
  // Regression: two `bun test` runs at once both bound 43000 and each failed the other's
  // port tests with EADDRINUSE.
  it('gives two different processes different windows', () => {
    expect(testPortBase(1001)).not.toBe(testPortBase(1002));
    expect(Math.abs(testPortBase(1001) - testPortBase(1002))).toBeGreaterThanOrEqual(30);
  });

  it('keeps the whole window inside the valid port range, whatever the pid', () => {
    for (const pid of [1, 2, 99_999, 4_194_304, 1_500, 1_499]) {
      const base = testPortBase(pid);
      expect(base).toBeGreaterThanOrEqual(1024);
      expect(base + 30).toBeLessThanOrEqual(65535);
    }
  });

  it('is what the port tests are configured with', () => {
    expect(TEST_CONFIG.ports.base).toBe(testPortBase());
  });
});
