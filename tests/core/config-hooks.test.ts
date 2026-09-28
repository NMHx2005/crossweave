import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, loadConfig } from '../../src/core/config.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'cw-hooks-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const write = (cfg: unknown): Promise<void> => writeFile(join(dir, 'crossweave.config.json'), JSON.stringify(cfg));

describe('loadConfig hooks', () => {
  it('parses both hooks, and leaves hooks absent when the file says nothing', async () => {
    expect(loadConfig(dir).hooks).toBeUndefined();
    await write({ hooks: { sessionSetup: 'bun install', sessionTeardown: 'docker compose down' } });
    expect(loadConfig(dir).hooks).toEqual({ sessionSetup: 'bun install', sessionTeardown: 'docker compose down' });
  });

  it('keeps just one of the two', async () => {
    await write({ hooks: { sessionSetup: 'bun install' } });
    expect(loadConfig(dir).hooks).toEqual({ sessionSetup: 'bun install' });
  });

  it('rejects a non-string, a blank, a multi-line hook, and hooks that is not an object', async () => {
    for (const bad of [
      { hooks: { sessionSetup: 5 } },
      { hooks: { sessionSetup: '   ' } },
      { hooks: { sessionSetup: 'a\nb' } },
      { hooks: 'not-an-object' },
    ]) {
      await write(bad);
      expect(() => loadConfig(dir)).toThrowError(
        expect.objectContaining({ code: 'CONFIG_INVALID' }) as unknown as Error,
      );
    }
  });

  it('leaves the other sections at their defaults', async () => {
    await write({ hooks: { sessionSetup: 'x' } });
    const cfg = loadConfig(dir);
    expect(cfg.ports).toEqual(DEFAULT_CONFIG.ports);
    expect(cfg.converge.mergeStrategy).toBe(DEFAULT_CONFIG.converge.mergeStrategy);
    expect(cfg.disk).toEqual(DEFAULT_CONFIG.disk);
  });
});
