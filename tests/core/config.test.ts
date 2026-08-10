import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, DEFAULT_CONFIG } from '../../src/core/config.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'cw-config-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('loadConfig', () => {
  it('returns defaults when no config file exists', () => {
    expect(loadConfig(dir)).toEqual(DEFAULT_CONFIG);
  });

  it('merges a partial file over the defaults', async () => {
    await writeFile(
      join(dir, 'crossweave.config.json'),
      JSON.stringify({ ports: { base: 50000 }, disk: { perSessionBytes: 1024 } }),
    );
    const cfg = loadConfig(dir);
    expect(cfg.ports.base).toBe(50000);
    // Untouched keys keep their defaults rather than becoming undefined.
    expect(cfg.ports.blockSize).toBe(DEFAULT_CONFIG.ports.blockSize);
    expect(cfg.disk.perSessionBytes).toBe(1024);
    expect(cfg.disk.perWorkspaceBytes).toBe(DEFAULT_CONFIG.disk.perWorkspaceBytes);
  });

  it('rejects malformed JSON with a usable message', async () => {
    await writeFile(join(dir, 'crossweave.config.json'), '{ not json');
    expect(() => loadConfig(dir)).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID' }) as unknown as Error,
    );
  });

  it('rejects a port base that cannot hold a block', async () => {
    await writeFile(
      join(dir, 'crossweave.config.json'),
      JSON.stringify({ ports: { base: 65530, blockSize: 10 } }),
    );
    expect(() => loadConfig(dir)).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID' }) as unknown as Error,
    );
  });

  it('rejects a db strategy it does not implement', async () => {
    await writeFile(
      join(dir, 'crossweave.config.json'),
      JSON.stringify({ db: { strategy: 'branch' } }),
    );
    expect(() => loadConfig(dir)).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID' }) as unknown as Error,
    );
  });
});
