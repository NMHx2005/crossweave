import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskTracker, type DiskFs, type DiskEntry } from '../../src/daemon/disk-usage.js';

type Node = { size: number } | { children: Record<string, Node> } | { link: true } | { unreadable: true };

/** An in-memory tree with the calls counted and an optional per-call hook. */
function fakeFs(tree: Record<string, Node>, hook?: () => void): DiskFs & { reads: string[]; live: { now: number; peak: number } } {
  const live = { now: 0, peak: 0 };
  const reads: string[] = [];
  const at = (path: string): Node | undefined => {
    const parts = path.split('/').filter(Boolean);
    let node: Node | undefined = { children: tree };
    for (const p of parts) {
      if (node === undefined || !('children' in node)) return undefined;
      node = node.children[p];
    }
    return node;
  };
  return {
    reads,
    live,
    async readdir(path: string): Promise<DiskEntry[]> {
      reads.push(path);
      live.now += 1;
      live.peak = Math.max(live.peak, live.now);
      try {
        hook?.();
        await new Promise((r) => setTimeout(r, 1));
        const node = path === '/' ? ({ children: tree } as Node) : at(path);
        if (node === undefined) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        if ('unreadable' in node) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        if (!('children' in node)) throw Object.assign(new Error('not a dir'), { code: 'ENOTDIR' });
        return Object.entries(node.children).map(([name, child]): DiskEntry => ({
          name,
          kind: 'children' in child || 'unreadable' in child ? 'dir' : 'link' in child ? 'other' : 'file',
        }));
      } finally {
        live.now -= 1;
      }
    },
    async fileSize(path: string): Promise<number> {
      const node = at(path);
      if (node === undefined || !('size' in node)) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      return node.size;
    },
  };
}

const T0 = 1_000_000;
const clock = () => { let now = T0; return { now: () => now, advance: (ms: number) => { now += ms; } }; };

describe('DiskTracker', () => {
  test('sums file sizes through nested directories and ignores links', async () => {
    const fs = fakeFs({ a: { children: { 'x.bin': { size: 100 }, deep: { children: { 'y.bin': { size: 20 }, l: { link: true } } } } }, 'z.bin': { size: 3 } });
    const t = new DiskTracker({ fs });
    expect(await t.measure('/')).toMatchObject({ bytes: 123, approx: false });
  });

  test('many files in ONE directory add up exactly (sizes are read concurrently: no lost updates)', async () => {
    const files: Record<string, Node> = {};
    let expected = 0;
    for (let i = 1; i <= 200; i++) { files[`f${i}`] = { size: i }; expected += i; }
    const t = new DiskTracker({ fs: fakeFs(files) });
    expect((await t.measure('/')).bytes).toBe(expected);
  });

  test('a path that is gone is 0 bytes and exact, never an error', async () => {
    const t = new DiskTracker({ fs: fakeFs({}) });
    expect(await t.measure('/nope')).toMatchObject({ bytes: 0, approx: false });
  });

  test('an unreadable directory is skipped but marks the figure as a lower bound', async () => {
    const t = new DiskTracker({ fs: fakeFs({ ok: { children: { f: { size: 5 } } }, locked: { unreadable: true } }) });
    expect(await t.measure('/')).toMatchObject({ bytes: 5, approx: true });
  });

  test('a file that vanishes between listing and sizing is not an error and not approximate', async () => {
    const fs = fakeFs({ f: { size: 9 } });
    const original = fs.fileSize.bind(fs);
    let first = true;
    fs.fileSize = async (p: string) => { if (first) { first = false; throw Object.assign(new Error('gone'), { code: 'ENOENT' }); } return original(p); };
    const t = new DiskTracker({ fs });
    expect(await t.measure('/')).toMatchObject({ bytes: 0, approx: false });
  });

  test('past its deadline the walk stops and the figure is a lower bound', async () => {
    const c = clock();
    const tree: Record<string, Node> = {};
    for (let i = 0; i < 40; i++) tree[`d${i}`] = { children: { f: { size: 1 } } };
    const fs = fakeFs(tree, () => c.advance(100));
    const t = new DiskTracker({ fs, now: c.now, deadlineMs: 500, concurrency: 1 });
    const r = await t.measure('/');
    expect(r.approx).toBe(true);
    expect(r.bytes).toBeLessThan(40);
    expect(fs.reads.length).toBeLessThan(41);
  });

  test('two callers asking at once share one walk', async () => {
    const fs = fakeFs({ a: { children: { f: { size: 1 } } } });
    const t = new DiskTracker({ fs });
    const [x, y] = await Promise.all([t.measure('/'), t.measure('/')]);
    expect(x).toEqual(y);
    expect(fs.reads.filter((p) => p === '/')).toHaveLength(1);
  });

  test('a fresh figure is served from the cache; a stale one is walked again; get() returns the stale figure meanwhile', async () => {
    const c = clock();
    const fs = fakeFs({ f: { size: 7 } });
    const t = new DiskTracker({ fs, now: c.now, ttlMs: 60_000 });
    await t.measure('/');
    const walks = fs.reads.length;
    c.advance(30_000);
    await t.measure('/');
    expect(fs.reads.length).toBe(walks);
    c.advance(31_000);
    expect(t.get('/')).toMatchObject({ bytes: 7 }); // stale but still there
    await t.measure('/');
    expect(fs.reads.length).toBeGreaterThan(walks);
  });

  test('a caller can ask for a fresher figure than the default age, and clear() forgets everything', async () => {
    const c = clock();
    const fs = fakeFs({ f: { size: 7 } });
    const t = new DiskTracker({ fs, now: c.now, ttlMs: 60_000 });
    await t.measure('/');
    const walks = fs.reads.length;
    c.advance(4_000);
    await t.measure('/', { maxAgeMs: 3_000 }); // older than this caller accepts: walks again
    expect(fs.reads.length).toBeGreaterThan(walks);
    t.clear();
    expect(t.get('/')).toBeUndefined();
  });

  test('never runs more directory reads at once than its concurrency', async () => {
    const tree: Record<string, Node> = {};
    for (let i = 0; i < 30; i++) tree[`d${i}`] = { children: { f: { size: 1 } } };
    const fs = fakeFs(tree);
    const t = new DiskTracker({ fs, concurrency: 3 });
    await t.measure('/');
    expect(fs.live.peak).toBeLessThanOrEqual(3);
  });

  test('a filesystem that throws something odd is contained: the figure is a lower bound, nothing escapes', async () => {
    const fs: DiskFs = { readdir: async () => { throw 'boom'; }, fileSize: async () => 1 };
    const t = new DiskTracker({ fs });
    expect(await t.measure('/x')).toMatchObject({ bytes: 0, approx: true });
  });

  test('refresh starts walks only for paths with no fresh figure, and never rejects', async () => {
    const c = clock();
    const fs = fakeFs({ a: { children: { f: { size: 2 } } } });
    const t = new DiskTracker({ fs, now: c.now });
    t.refresh(['/a', '/a', '/missing']);
    await t.idle();
    expect(t.get('/a')).toMatchObject({ bytes: 2 });
    const walks = fs.reads.length;
    t.refresh(['/a']);
    await t.idle();
    expect(fs.reads.length).toBe(walks);
  });

  test('forget drops a figure so the next ask walks again', async () => {
    const fs = fakeFs({ f: { size: 1 } });
    const t = new DiskTracker({ fs });
    await t.measure('/');
    t.forget('/');
    expect(t.get('/')).toBeUndefined();
  });

  test('a total bytes figure is never negative, NaN or fractional', async () => {
    const fs: DiskFs = {
      readdir: async () => [{ name: 'a', kind: 'file' }, { name: 'b', kind: 'file' }, { name: 'c', kind: 'file' }],
      fileSize: async (p: string) => (p.endsWith('a') ? -5 : p.endsWith('b') ? Number.NaN : 2.7),
    };
    const t = new DiskTracker({ fs });
    const r = await t.measure('/x');
    expect(Number.isInteger(r.bytes)).toBe(true);
    expect(r.bytes).toBeGreaterThanOrEqual(0);
  });
});

describe('DiskTracker on the real filesystem', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try { chmodSync(join(d, 'locked'), 0o755); } catch { /* not there */ }
      rmSync(d, { recursive: true, force: true });
    }
  });

  test('counts real files, does not follow a symlink loop, and flags an unreadable directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cw-disk-'));
    dirs.push(root);
    writeFileSync(join(root, 'a.txt'), 'x'.repeat(1000));
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'b.txt'), 'y'.repeat(500));
    symlinkSync(root, join(root, 'sub', 'loop'));
    mkdirSync(join(root, 'locked'));
    writeFileSync(join(root, 'locked', 'hidden.txt'), 'z'.repeat(999));
    chmodSync(join(root, 'locked'), 0o000);
    const t = new DiskTracker();
    const r = await t.measure(root);
    expect(r.bytes).toBe(1500);
    expect(r.approx).toBe(true);
  });

  test('a path that does not exist is 0', async () => {
    expect(await new DiskTracker().measure(join(tmpdir(), 'cw-definitely-not-here-12345'))).toMatchObject({ bytes: 0, approx: false });
  });
});
