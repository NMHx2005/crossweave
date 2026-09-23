import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConsent, setConsent, record } from '../../src/gateway/telemetry.js';
import { readFileSync, existsSync } from 'node:fs';
import { crossweaveDir } from '../../src/core/paths.js';

describe('telemetry opt-in', () => {
  it('default off, set/get, record only when consented', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-telemetry-'));
    try {
      expect(getConsent(dir)).toBe(false);
      record(dir, { kind: 'test', agentKind: 'claude' });
      const day = new Date().toISOString().slice(0, 10);
      expect(existsSync(join(crossweaveDir(dir), `telemetry-${day}.json`))).toBe(false);
      setConsent(dir, true);
      expect(getConsent(dir)).toBe(true);
      record(dir, { kind: 'test', agentKind: 'claude', path: '/secret/should/not/record' });
      const raw = JSON.parse(readFileSync(join(crossweaveDir(dir), `telemetry-${day}.json`), 'utf8')) as Record<string, unknown>[];
      expect(raw[0]).not.toHaveProperty('path');
      expect(raw[0]).toHaveProperty('kind');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
