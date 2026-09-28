import { describe, expect, test } from 'bun:test';
import { OverlapTracker } from '../../src/daemon/overlap.js';
import type { RepoScan } from '../../src/daemon/repo-scan.js';

const scanOf = (changed: string[], committed: string[] = []): RepoScan => ({
  changed: changed.length, ahead: 0, changedPaths: changed, committedPaths: committed,
});

describe('OverlapTracker', () => {
  test('names overlaps from the paths, throttles, and reports only a real change', async () => {
    let clock = 0;
    let reads = 0;
    const byFolder: Record<string, RepoScan> = { '/a': scanOf(['x.ts']), '/b': scanOf(['x.ts', 'y.ts']) };
    const tracker = new OverlapTracker(async (folder) => { reads += 1; return byFolder[folder] ?? null; }, () => clock, 5000);
    const targets = () => [
      { id: 's1', name: 'alice', folder: '/a', baseHead: 'base' },
      { id: 's2', name: 'bob', folder: '/b', baseHead: 'base' },
    ];

    expect(tracker.get('s1')).toBeUndefined();
    expect(await tracker.refresh(targets)).toBe(true);
    expect(tracker.get('s1')).toEqual([{ session: 'bob', paths: ['x.ts'] }]);
    expect(tracker.get('s2')).toEqual([{ session: 'alice', paths: ['x.ts'] }]);
    expect(reads).toBe(2);

    clock = 1000;
    expect(await tracker.refresh(targets)).toBe(false);
    expect(reads).toBe(2);

    clock = 6000;
    expect(await tracker.refresh(targets)).toBe(false); // read again, same picture
    expect(reads).toBe(4);

    clock = 12000;
    byFolder['/b'] = scanOf(['y.ts']); // no longer overlaps
    expect(await tracker.refresh(targets)).toBe(true);
    expect(tracker.get('s1')).toBeUndefined();
    expect(tracker.get('s2')).toBeUndefined();
  });

  test('committed paths count too, not just uncommitted ones', async () => {
    const tracker = new OverlapTracker(async (folder) => (folder === '/a' ? scanOf([], ['shared.ts']) : scanOf(['shared.ts'])), () => 0, 0);
    await tracker.refresh(() => [
      { id: 's1', name: 'alice', folder: '/a', baseHead: 'base' },
      { id: 's2', name: 'bob', folder: '/b', baseHead: 'base' },
    ]);
    expect(tracker.get('s1')).toEqual([{ session: 'bob', paths: ['shared.ts'] }]);
  });

  test('a session no longer listed is forgotten', async () => {
    let clock = 0;
    const tracker = new OverlapTracker(async () => scanOf(['x.ts']), () => clock, 5000);
    const both = () => [
      { id: 's1', name: 'alice', folder: '/a', baseHead: null },
      { id: 's2', name: 'bob', folder: '/b', baseHead: null },
    ];
    await tracker.refresh(both);
    expect(tracker.get('s1')).toHaveLength(1);
    clock = 6000;
    expect(await tracker.refresh(() => [{ id: 's1', name: 'alice', folder: '/a', baseHead: null }])).toBe(true);
    expect(tracker.get('s1')).toBeUndefined();
  });

  test('a folder git cannot read is skipped, not treated as empty', async () => {
    const tracker = new OverlapTracker(async (folder) => (folder === '/gone' ? null : scanOf(['x.ts'])), () => 0, 0);
    await tracker.refresh(() => [
      { id: 's1', name: 'alice', folder: '/gone', baseHead: null },
      { id: 's2', name: 'bob', folder: '/b', baseHead: null },
    ]);
    expect(tracker.get('s1')).toBeUndefined();
    expect(tracker.get('s2')).toBeUndefined();
  });

  test('two refreshes at once read once', async () => {
    let reads = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const tracker = new OverlapTracker(async () => { reads += 1; await gate; return scanOf(['x.ts']); }, () => 0, 0);
    const targets = () => [
      { id: 's1', name: 'alice', folder: '/a', baseHead: null },
      { id: 's2', name: 'bob', folder: '/b', baseHead: null },
    ];
    const first = tracker.refresh(targets);
    expect(await tracker.refresh(targets)).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(reads).toBe(2);
  });
});
