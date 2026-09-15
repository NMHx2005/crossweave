import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { MergeTrialRepo, isPairwiseTrial, type MergeTrialRow } from '../../src/db/repositories/merge-trial.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';

function row(overrides: Partial<MergeTrialRow> = {}): MergeTrialRow {
  return {
    id: 'mt_1', workspaceId: 'ws_1', ts: 'now',
    branches: ['cw/a', 'cw/b'], result: 'clean', detail: null, baseHead: 'base-abc',
    pairwise: true,
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
    expect(rows[0]?.baseHead).toBe('base-abc');
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

  // C1: the trial kind has to survive the round-trip, because a full-integration
  // trial over exactly 2 active sessions is indistinguishable from a pairwise one
  // by branch count alone — and after a daemon restart the recorded row is the
  // only place that distinction can come from.
  test('the recorded trial kind round-trips for both kinds, including a 2-branch full integration', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const repo = new MergeTrialRepo(db);
    repo.insert(row({ id: 'mt_pair', ts: '1', pairwise: true }));
    repo.insert(row({ id: 'mt_full', ts: '2', pairwise: false })); // same 2 branches

    const [pair, full] = repo.listByWorkspace('ws_1');
    expect(pair?.pairwise).toBe(true);
    expect(full?.pairwise).toBe(false);
    expect(isPairwiseTrial(pair as MergeTrialRow)).toBe(true);
    expect(isPairwiseTrial(full as MergeTrialRow)).toBe(false);
  });

  test('a row written before the kind column reads back as null and falls back to the branch count', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const repo = new MergeTrialRepo(db);
    // What the v10 -> v11 migration leaves behind: the column exists, nothing filled it.
    db.run(
      "INSERT INTO merge_trial (id, workspace_id, ts, branches, result, detail, base_head)"
      + " VALUES ('mt_legacy','ws_1','1','[\"cw/a\",\"cw/b\"]','clean',NULL,'base-abc')",
    );

    const legacy = repo.listByWorkspace('ws_1')[0] as MergeTrialRow;
    expect(legacy.pairwise).toBeNull();
    expect(isPairwiseTrial(legacy)).toBe(true);
    expect(isPairwiseTrial({ ...legacy, branches: ['cw/a', 'cw/b', 'cw/c'] })).toBe(false);
  });
});
