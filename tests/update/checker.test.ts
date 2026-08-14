import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkForUpdate } from '../../src/update/checker.js';
import { loadGlobalConfig, saveGlobalConfig, DEFAULT_GLOBAL_CONFIG } from '../../src/update/global-config.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cw-checker-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function fakeFetch(tagName: string): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ tag_name: tagName }), { status: 200 })) as unknown as typeof fetch;
}

describe('checkForUpdate', () => {
  test('returns a notice when a newer version is published', async () => {
    const notice = await checkForUpdate('0.1.0', { homeDir: home, fetchFn: fakeFetch('v0.2.0') });
    expect(notice).toContain('v0.2.0');
    expect(notice).toContain('0.1.0');
    expect(notice).toContain('cw update');
  });

  test('returns undefined when already on the latest version', async () => {
    const notice = await checkForUpdate('0.2.0', { homeDir: home, fetchFn: fakeFetch('v0.2.0') });
    expect(notice).toBeUndefined();
  });

  test('respects updateCheck: false', async () => {
    saveGlobalConfig({ ...DEFAULT_GLOBAL_CONFIG, updateCheck: false }, home);
    const notice = await checkForUpdate('0.1.0', { homeDir: home, fetchFn: fakeFetch('v0.2.0') });
    expect(notice).toBeUndefined();
  });

  test('does not re-check within the 24h cache window', async () => {
    let calls = 0;
    const countingFetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ tag_name: 'v0.2.0' }), { status: 200 });
    }) as unknown as typeof fetch;
    const now = 1_000_000_000_000;
    await checkForUpdate('0.1.0', { homeDir: home, fetchFn: countingFetch, clock: () => now });
    await checkForUpdate('0.1.0', { homeDir: home, fetchFn: countingFetch, clock: () => now + 60_000 });
    expect(calls).toBe(1);
  });

  test('re-checks once 24h have passed', async () => {
    let calls = 0;
    const countingFetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ tag_name: 'v0.2.0' }), { status: 200 });
    }) as unknown as typeof fetch;
    const now = 1_000_000_000_000;
    await checkForUpdate('0.1.0', { homeDir: home, fetchFn: countingFetch, clock: () => now });
    await checkForUpdate('0.1.0', { homeDir: home, fetchFn: countingFetch, clock: () => now + 25 * 60 * 60 * 1000 });
    expect(calls).toBe(2);
  });

  test('only notifies once per version, not once per command', async () => {
    const now = 1_000_000_000_000;
    let tick = 0;
    const clock = () => now + (tick++) * 25 * 60 * 60 * 1000; // force a fresh check every call
    const first = await checkForUpdate('0.1.0', { homeDir: home, fetchFn: fakeFetch('v0.2.0'), clock });
    const second = await checkForUpdate('0.1.0', { homeDir: home, fetchFn: fakeFetch('v0.2.0'), clock });
    expect(first).toContain('v0.2.0');
    expect(second).toBeUndefined();
  });

  test('a network failure is swallowed silently and does not update the cache timestamp', async () => {
    const throwingFetch = (async () => { throw new Error('boom'); }) as unknown as typeof fetch;
    const before = loadGlobalConfig(home).lastCheckedAt;
    const notice = await checkForUpdate('0.1.0', { homeDir: home, fetchFn: throwingFetch });
    expect(notice).toBeUndefined();
    expect(loadGlobalConfig(home).lastCheckedAt).toBe(before);
  });

  test('a non-2xx response is swallowed silently', async () => {
    const failFetch = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    const notice = await checkForUpdate('0.1.0', { homeDir: home, fetchFn: failFetch });
    expect(notice).toBeUndefined();
  });
});
