import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { countChanged, GitCounter, readGitCounts, type GitCounts } from '../../src/daemon/git-counts.js';

describe('countChanged', () => {
  test('one per non-empty porcelain line', () => {
    expect(countChanged('')).toBe(0);
    expect(countChanged(' M a.ts\n?? b.ts\nR  c.ts -> d.ts\n')).toBe(3);
    // crossweave's own state directory is not a change of the user's.
    expect(countChanged('?? .crossweave/\n M a.ts\n')).toBe(1);
    expect(countChanged('?? .crossweave/state.db\n')).toBe(0);
    expect(countChanged('?? .crossweaver.txt\n')).toBe(1);
  });
});

describe('readGitCounts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-git-counts-'));
  afterAll(() => {
    try { renameSync(dir, join(homedir(), '.Trash', `cw-git-counts-${Date.now()}`)); } catch { /* left in tmp */ }
  });
  const g = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

  test('uncommitted files and commits past the base; null outside a repository', async () => {
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    writeFileSync(join(dir, 'a.txt'), 'a');
    g('add', '.');
    g('commit', '-qm', 'base');
    const base = g('rev-parse', 'HEAD');
    expect(await readGitCounts(dir, base)).toEqual({ changed: 0, ahead: 0 });

    writeFileSync(join(dir, 'b.txt'), 'b');
    g('add', '.');
    g('commit', '-qm', 'one');
    writeFileSync(join(dir, 'a.txt'), 'changed');
    writeFileSync(join(dir, 'c.txt'), 'new');
    expect(await readGitCounts(dir, base)).toEqual({ changed: 2, ahead: 1 });
    expect(await readGitCounts(dir, null)).toEqual({ changed: 2, ahead: null });
    expect(await readGitCounts(tmpdir(), base)).toBeNull();
  });
});

describe('GitCounter', () => {
  test('serves the last read, throttles, and says when something changed', async () => {
    let clock = 0;
    let answer: GitCounts | null = { changed: 1, ahead: 2 };
    let reads = 0;
    const counter = new GitCounter(async () => { reads += 1; return answer; }, () => clock, 3000);
    const targets = () => [{ id: 's1', folder: '/w', baseHead: 'abc' }];

    expect(counter.get('s1')).toBeUndefined();
    expect(await counter.refresh(targets)).toBe(true);
    expect(counter.get('s1')).toEqual({ changed: 1, ahead: 2 });

    clock = 1000;
    expect(await counter.refresh(targets)).toBe(false);
    expect(reads).toBe(1);

    clock = 4000;
    expect(await counter.refresh(targets)).toBe(false);
    expect(reads).toBe(2);

    clock = 8000;
    answer = null;
    expect(await counter.refresh(targets)).toBe(true);
    expect(counter.get('s1')).toBeUndefined();
  });

  test('a session no longer listed is forgotten', async () => {
    let clock = 0;
    const counter = new GitCounter(async () => ({ changed: 0, ahead: 0 }), () => clock, 3000);
    await counter.refresh(() => [{ id: 's1', folder: '/w', baseHead: null }]);
    clock = 5000;
    expect(await counter.refresh(() => [])).toBe(true);
    expect(counter.get('s1')).toBeUndefined();
  });

  test('two refreshes at once read once', async () => {
    let reads = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const counter = new GitCounter(async () => { reads += 1; await gate; return { changed: 0, ahead: 0 }; }, () => 0, 0);
    const first = counter.refresh(() => [{ id: 's1', folder: '/w', baseHead: null }]);
    expect(await counter.refresh(() => [{ id: 's1', folder: '/w', baseHead: null }])).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(reads).toBe(1);
  });
});
