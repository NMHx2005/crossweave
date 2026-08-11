import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { MergeTrialRepo, type MergeTrialRow } from '../../src/db/repositories/merge-trial.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';

function row(overrides: Partial<MergeTrialRow> = {}): MergeTrialRow {
  return {
    id: 'mt_1', workspaceId: 'ws_1', ts: 'now',
    branches: ['cw/a', 'cw/b'], result: 'clean', detail: null,
    ...overrides,
  };
}

function seed(db: ReturnType<typeof openDatabase>) {
  new WorkspaceRepo(db).insert({
    id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
    defaultIsolation: 'worktree', safeModeTier: 'T1',
  });
}

describe('MergeTrialRepo', () => {
  test('insert then listByWorkspace round-trips, branches parsed back to an array', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const repo = new MergeTrialRepo(db);
    repo.insert(row());

    const rows = repo.listByWorkspace('ws_1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.branches).toEqual(['cw/a', 'cw/b']);
    expect(rows[0]?.result).toBe('clean');
    expect(rows[0]?.detail).toBeNull();
  });

  test('listByWorkspace orders oldest first, matching every other listByWorkspace in this codebase', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const repo = new MergeTrialRepo(db);
    repo.insert(row({ id: 'mt_1', ts: '2026-01-01T00:00:01.000Z' }));
    repo.insert(row({ id: 'mt_2', ts: '2026-01-01T00:00:02.000Z' }));

    const rows = repo.listByWorkspace('ws_1');
    expect(rows.map((r) => r.id)).toEqual(['mt_1', 'mt_2']);
  });

  test('a conflict result carries the conflicting file list in detail', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const repo = new MergeTrialRepo(db);
    repo.insert(row({ result: 'conflict', detail: 'src/x.ts\nsrc/y.ts' }));

    expect(repo.listByWorkspace('ws_1')[0]?.detail).toBe('src/x.ts\nsrc/y.ts');
  });
});
