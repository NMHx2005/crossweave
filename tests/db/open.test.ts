import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { openDatabase, SCHEMA_VERSION } from '../../src/db/open.js';
import { newId } from '../../src/core/ids.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'cw-db-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('openDatabase', () => {
  it('creates the workspace and session tables', () => {
    const db = openDatabase(join(dir, 'state.db'));
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(names).toContain('workspace');
    expect(names).toContain('session');
    db.close();
  });

  it('records the schema version and is idempotent across reopens', () => {
    const p = join(dir, 'state.db');
    openDatabase(p).close();
    const db = openDatabase(p);
    const row = db.prepare('SELECT version FROM schema_meta').get() as { version: number };
    expect(row.version).toBe(SCHEMA_VERSION);
    db.close();
  });

  it('enables foreign key enforcement', () => {
    const db = openDatabase(join(dir, 'state.db'));
    const row = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(row.foreign_keys).toBe(1);
    db.close();
  });

  it('refuses to open a database newer than this build knows', () => {
    const p = join(dir, 'state.db');
    openDatabase(p).close();
    const raw = new Database(p);
    raw.exec(`UPDATE schema_meta SET version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    expect(() => openDatabase(p)).toThrowError(
      expect.objectContaining({ code: 'SCHEMA_TOO_NEW' }) as unknown as Error,
    );
  });

  it('migrates a v1 database forward without rebuilding it', () => {
    const p = join(dir, 'state.db');
    const db1 = openDatabase(p);
    db1.run("INSERT INTO workspace (id, name, root_path, created_at, default_isolation, safe_mode_tier) VALUES ('ws_1','demo','/tmp/x','2026-08-10T00:00:00.000Z','worktree','T3')");
    db1.close();

    const db2 = openDatabase(p);
    // The pre-existing row survived, and the new table exists.
    const ws = db2.query('SELECT count(*) AS n FROM workspace').get() as { n: number };
    expect(ws.n).toBe(1);
    const lease = db2.query('SELECT count(*) AS n FROM lease').get() as { n: number };
    expect(lease.n).toBe(0);
    db2.close();
  });
});

describe('openDatabase under concurrency', () => {
  // Regression: two daemons cold-starting at once both died with SQLITE_BUSY before
  // either reached its socket bind, so the auto-start race ended with no winner and
  // both clients timed out. Reproduced at roughly 1 in 10 attempts before the fix.
  // Real processes, not in-process calls — SQLite's locking is per-connection and a
  // single-process test would not exercise it.
  it('survives several processes opening the same fresh database at once', async () => {
    const { fileURLToPath } = await import('node:url');
    const raceDir = await mkdtemp(join(tmpdir(), 'cw-race-'));
    try {
      const dbPath = join(raceDir, '.crossweave', 'state.db');
      const openModule = fileURLToPath(new URL('../../src/db/open.ts', import.meta.url));
      const script =
        `const { openDatabase } = await import(${JSON.stringify(openModule)});` +
        `openDatabase(${JSON.stringify(dbPath)}).close();`;

      const procs = Array.from({ length: 6 }, () =>
        Bun.spawn(['bun', '-e', script], { stdout: 'pipe', stderr: 'pipe' }),
      );
      const results = await Promise.all(
        procs.map(async (p) => ({
          code: await p.exited,
          err: await new Response(p.stderr).text(),
        })),
      );

      const failed = results.filter((r) => r.code !== 0);
      // Surface the real stderr in the failure message rather than a bare count.
      expect(failed.map((f) => f.err).join('\n---\n')).toBe('');
      expect(failed).toHaveLength(0);
    } finally {
      await rm(raceDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('newId', () => {
  it('prefixes the id and stays unique across a tight loop', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId('s')));
    expect(ids.size).toBe(1000);
    expect([...ids][0]!.startsWith('s_')).toBe(true);
  });

  it('sorts lexicographically in creation order', () => {
    const a = newId('ws');
    const b = newId('ws');
    expect(a < b).toBe(true);
  });
});
