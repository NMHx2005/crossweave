import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRepoScan, RepoScanner, statusPaths } from '../../src/daemon/repo-scan.js';

function trash(dir: string): void {
  try { renameSync(dir, join(homedir(), '.Trash', `cw-${Date.now()}-${Math.random().toString(36).slice(2)}`)); } catch { /* left in tmp */ }
}

describe('statusPaths', () => {
  test('one per path; both ends of a rename; .crossweave/ dropped; sorted', () => {
    expect(statusPaths(' M a.ts\n?? b.ts\n')).toEqual(['a.ts', 'b.ts']);
    expect(statusPaths('R  old.ts -> new.ts\n')).toEqual(['new.ts', 'old.ts']);
    expect(statusPaths('?? .crossweave/state.db\n?? .crossweaver.txt\n')).toEqual(['.crossweaver.txt']);
  });
});

describe('readRepoScan', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-repo-scan-'));
  afterAll(() => trash(dir));
  const g = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

  test('changed + committed paths and the counts; null outside a repository', async () => {
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    writeFileSync(join(dir, 'a.txt'), 'a');
    g('add', '.');
    g('commit', '-qm', 'base');
    const base = g('rev-parse', 'HEAD');
    expect(await readRepoScan(dir, base)).toEqual({ changed: 0, ahead: 0, changedPaths: [], committedPaths: [] });

    writeFileSync(join(dir, 'a.txt'), 'changed');
    writeFileSync(join(dir, 'c.txt'), 'new');
    g('add', '.');
    g('commit', '-qm', 'one');
    writeFileSync(join(dir, 'untracked.txt'), 'u');
    const scan = await readRepoScan(dir, base);
    expect(scan?.ahead).toBe(1);
    expect(scan?.committedPaths).toEqual(['a.txt', 'c.txt']);
    expect(scan?.changedPaths).toEqual(['untracked.txt']);
    expect(scan?.changed).toBe(1);

    expect(await readRepoScan(tmpdir(), base)).toBeNull();
  });

  test("crossweave's own state directory is not a path the user touched", async () => {
    const d2 = mkdtempSync(join(tmpdir(), 'cw-repo-scan2-'));
    const gg = (...args: string[]): string => execFileSync('git', args, { cwd: d2, encoding: 'utf8' }).trim();
    gg('init', '-q', '-b', 'main');
    gg('config', 'user.email', 't@t');
    gg('config', 'user.name', 't');
    writeFileSync(join(d2, 'a.txt'), 'a');
    gg('add', '.');
    gg('commit', '-qm', 'base');
    const base = gg('rev-parse', 'HEAD');
    mkdirSync(join(d2, '.crossweave'));
    writeFileSync(join(d2, '.crossweave', 'state.db'), 'x');
    const scan = await readRepoScan(d2, base);
    expect(scan?.changedPaths).toEqual([]);
    expect(scan?.changed).toBe(0);
    trash(d2);
  });
});

describe('RepoScanner', () => {
  test('two scans of the same folder at once read once; a fresh one reads again after the interval', async () => {
    let reads = 0;
    let clock = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const scanner = new RepoScanner(
      async () => { reads += 1; await gate; return { changed: 0, ahead: null, changedPaths: [], committedPaths: [] }; },
      () => clock,
      2000,
    );
    const a = scanner.scan('/w', null);
    const b = scanner.scan('/w', null);
    release();
    await Promise.all([a, b]);
    expect(reads).toBe(1);

    clock = 1000;
    await scanner.scan('/w', null);
    expect(reads).toBe(1);

    clock = 3000;
    await scanner.scan('/w', null);
    expect(reads).toBe(2);
  });

  test('an entry idle past maxAge is evicted, so the cache cannot grow without bound', async () => {
    let reads = 0;
    let clock = 0;
    const scanner = new RepoScanner(
      async () => { reads += 1; return { changed: 0, ahead: null, changedPaths: [], committedPaths: [] }; },
      () => clock,
      100_000,
      1000,
    );
    await scanner.scan('/w', null);
    expect(reads).toBe(1);
    clock = 500; // still cached by the (long) min interval, and younger than maxAge
    await scanner.scan('/w', null);
    expect(reads).toBe(1);
    clock = 2000; // past maxAge: pruned, so it reads again despite minInterval 100000
    await scanner.scan('/w', null);
    expect(reads).toBe(2);
  });

  test('counts() is the counts half of the same scan', async () => {
    const scanner = new RepoScanner(
      async () => ({ changed: 2, ahead: 1, changedPaths: ['a', 'b'], committedPaths: ['c'] }),
      () => 0,
      0,
    );
    expect(await scanner.counts('/w', 'base')).toEqual({ changed: 2, ahead: 1 });
  });
});
