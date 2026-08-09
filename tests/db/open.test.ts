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
