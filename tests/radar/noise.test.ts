import { describe, expect, test } from 'bun:test';
import { NotificationGate, references } from '../../src/radar/noise.js';

describe('NotificationGate', () => {
  test('allows the first notification for a given session/path/symbol', () => {
    let now = 0;
    const gate = new NotificationGate(() => now);
    expect(gate.shouldNotify('s_1', 'src/x.ts', 'foo')).toBe(true);
  });

  test('coalesces repeat notifications for the SAME symbol within the window', () => {
    let now = 0;
    const gate = new NotificationGate(() => now);
    expect(gate.shouldNotify('s_1', 'src/x.ts', 'foo')).toBe(true);
    now += 1000;
    expect(gate.shouldNotify('s_1', 'src/x.ts', 'foo')).toBe(false);
  });

  test('a different symbol is not coalesced by an unrelated one', () => {
    let now = 0;
    const gate = new NotificationGate(() => now);
    expect(gate.shouldNotify('s_1', 'src/x.ts', 'foo')).toBe(true);
    expect(gate.shouldNotify('s_1', 'src/x.ts', 'bar')).toBe(true);
  });

  test('rate-limits to 6 distinct notifications per 10 minutes per session', () => {
    let now = 0;
    const gate = new NotificationGate(() => now);
    for (let i = 0; i < 6; i += 1) {
      expect(gate.shouldNotify('s_1', 'src/x.ts', `sym${i}`)).toBe(true);
      now += 1; // distinct enough not to coalesce
    }
    expect(gate.shouldNotify('s_1', 'src/x.ts', 'sym6')).toBe(false);
  });

  test('the rate limit resets once entries age out of the 10-minute window', () => {
    let now = 0;
    const gate = new NotificationGate(() => now);
    for (let i = 0; i < 6; i += 1) {
      gate.shouldNotify('s_1', 'src/x.ts', `sym${i}`);
      now += 1;
    }
    now += 10 * 60 * 1000 + 1;
    expect(gate.shouldNotify('s_1', 'src/x.ts', 'sym6')).toBe(true);
  });

  test('rate limits are tracked per session, not globally', () => {
    let now = 0;
    const gate = new NotificationGate(() => now);
    for (let i = 0; i < 6; i += 1) {
      gate.shouldNotify('s_1', 'src/x.ts', `sym${i}`);
      now += 1;
    }
    expect(gate.shouldNotify('s_2', 'src/x.ts', 'sym0')).toBe(true);
  });
});

describe('references', () => {
  test('finds the symbol name inside a touched file', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'cw-ref-'));
    try {
      await writeFile(join(dir, 'consumer.ts'), 'import { AuthService } from "./auth";\nnew AuthService();\n');
      expect(references(dir, ['consumer.ts'], 'AuthService')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('returns false when the symbol name does not appear anywhere', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'cw-ref-'));
    try {
      await writeFile(join(dir, 'consumer.ts'), 'export const unrelated = 1;\n');
      expect(references(dir, ['consumer.ts'], 'AuthService')).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('returns false for an empty touched-files list without shelling out', () => {
    expect(references('/does/not/matter', [], 'AuthService')).toBe(false);
  });
});
