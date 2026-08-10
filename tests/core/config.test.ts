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

  // `ports.named` used to be the one section nothing validated, and
  // `LeaseManager.acquire` writes every entry straight into the agent's environment —
  // overriding whatever was already there. A file that looks like configuration could
  // replace the agent's PATH, or its loader, with a port number.
  describe('ports.named', () => {
    async function write(named: unknown, ports: Record<string, unknown> = {}): Promise<void> {
      await writeFile(
        join(dir, 'crossweave.config.json'),
        JSON.stringify({ ports: { ...ports, named } }),
      );
    }

    function expectInvalid(detail: string): void {
      let thrown: unknown;
      try {
        loadConfig(dir);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toMatchObject({ code: 'CONFIG_INVALID' });
      expect((thrown as Error).message).toContain(detail);
    }

    it('accepts a well-formed entry', async () => {
      await write({ API_PORT: 0, DB_PORT: 3 });
      expect(loadConfig(dir).ports.named).toEqual({ API_PORT: 0, DB_PORT: 3 });
    });

    it('rejects a key that is not a valid environment variable name', async () => {
      await write({ 'API-PORT': 0 });
      expectInvalid('API-PORT');
    });

    it('rejects a key that starts with a digit', async () => {
      await write({ '2FAST': 0 });
      expectInvalid('2FAST');
    });

    it('rejects PATH and the other reserved names', async () => {
      for (const name of ['PATH', 'HOME', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'CW_SESSION_ID',
        'CW_SESSION_NAME', 'CW_PORT_BASE']) {
        await write({ [name]: 0 });
        expectInvalid(name);
      }
    });

    it('rejects a non-integer offset', async () => {
      await write({ API_PORT: 1.5 });
      expectInvalid('API_PORT');
    });

    it('rejects a negative offset', async () => {
      await write({ API_PORT: -1 });
      expectInvalid('outside the block');
    });

    it('rejects an offset past the end of the block', async () => {
      await write({ API_PORT: 10 }, { blockSize: 10 });
      expectInvalid('outside the block');
    });

    it('rejects a named section that is not an object', async () => {
      await write(7);
      expectInvalid('ports.named must be an object');
    });
  });
});
