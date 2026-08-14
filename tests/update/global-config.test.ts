import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadGlobalConfig,
  saveGlobalConfig,
  DEFAULT_GLOBAL_CONFIG,
} from '../../src/update/global-config.js';
import { globalCrossweaveDir } from '../../src/core/paths.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cw-global-config-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('global-config', () => {
  test('loadGlobalConfig returns defaults when no file exists', () => {
    expect(loadGlobalConfig(home)).toEqual(DEFAULT_GLOBAL_CONFIG);
  });

  test('saveGlobalConfig then loadGlobalConfig round-trips', () => {
    const cfg = {
      ...DEFAULT_GLOBAL_CONFIG,
      installedVersion: 'v0.1.0',
      updateCheck: false,
      lastCheckedAt: '2026-08-14T00:00:00.000Z',
      lastKnownLatest: 'v0.2.0',
      lastNotifiedVersion: 'v0.2.0',
    };
    saveGlobalConfig(cfg, home);
    expect(loadGlobalConfig(home)).toEqual(cfg);
  });

  test('saveGlobalConfig creates ~/.crossweave if missing', () => {
    saveGlobalConfig(DEFAULT_GLOBAL_CONFIG, home);
    expect(existsSync(globalCrossweaveDir(home))).toBe(true);
  });

  test('a malformed config.json falls back to defaults rather than throwing', () => {
    saveGlobalConfig(DEFAULT_GLOBAL_CONFIG, home);
    const path = join(globalCrossweaveDir(home), 'config.json');
    require('node:fs').writeFileSync(path, '{not json');
    expect(loadGlobalConfig(home)).toEqual(DEFAULT_GLOBAL_CONFIG);
  });

  test('written file is valid JSON on disk', () => {
    saveGlobalConfig(DEFAULT_GLOBAL_CONFIG, home);
    const path = join(globalCrossweaveDir(home), 'config.json');
    expect(() => JSON.parse(readFileSync(path, 'utf8'))).not.toThrow();
  });
});
