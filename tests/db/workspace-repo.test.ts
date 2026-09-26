import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo, type WorkspaceRow } from '../../src/db/repositories/workspace.js';
import { newId } from '../../src/core/ids.js';

let dir: string;
let db: Database;
let repo: WorkspaceRepo;

function makeRow(overrides: Partial<WorkspaceRow> = {}): WorkspaceRow {
  return {
    id: newId('ws'),
    name: 'demo',
    rootPath: '/tmp/demo',
    createdAt: '2026-08-09T00:00:00.000Z',
    defaultIsolation: 'worktree',
    safeModeTier: 'T3',
    ...overrides,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cw-wsrepo-'));
  db = openDatabase(join(dir, 'state.db'));
  repo = new WorkspaceRepo(db);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('WorkspaceRepo', () => {
  it('round-trips a row through insert and findById', () => {
    const row = makeRow();
    repo.insert(row);
    expect(repo.findById(row.id)).toEqual(row);
  });

  it('returns undefined for an unknown id', () => {
    expect(repo.findById('ws_missing')).toBeUndefined();
  });

  it('finds by root path', () => {
    const row = makeRow({ name: 'alpha', rootPath: '/tmp/alpha' });
    repo.insert(row);
    expect(repo.findByRoot('/tmp/alpha')?.id).toBe(row.id);
  });

  it('lists rows ordered by creation time', () => {
    repo.insert(makeRow({ name: 'b', rootPath: '/tmp/b', createdAt: '2026-08-09T02:00:00.000Z' }));
    repo.insert(makeRow({ name: 'a', rootPath: '/tmp/a', createdAt: '2026-08-09T01:00:00.000Z' }));
    expect(repo.list().map((w) => w.name)).toEqual(['a', 'b']);
  });

  it('rejects a duplicate root path', () => {
    repo.insert(makeRow({ rootPath: '/tmp/same' }));
    expect(() => repo.insert(makeRow({ name: 'other', rootPath: '/tmp/same' }))).toThrow();
  });

  it('deletes a row', () => {
    const row = makeRow();
    repo.insert(row);
    repo.delete(row.id);
    expect(repo.findById(row.id)).toBeUndefined();
  });
});
