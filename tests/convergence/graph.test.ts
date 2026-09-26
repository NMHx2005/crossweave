import { describe, expect, test } from 'bun:test';
import { buildConflictGraph, recommendOrder } from '../../src/convergence/graph.js';
import type { MergeTrialRow } from '../../src/db/repositories/merge-trial.js';
import type { SessionRow } from '../../src/db/repositories/session.js';

function trial(overrides: Partial<MergeTrialRow>): MergeTrialRow {
  return {
    id: 't', workspaceId: 'ws_1', ts: 'now', branches: [],
    result: 'clean', detail: null, baseHead: 'base-current', pairwise: true, ...overrides,
  };
}

function session(id: string, branch: string, createdAt: string): SessionRow {
  return {
    id, workspaceId: 'ws_1', name: id, agentKind: 'claude', adapter: 'claude', status: 'running',
    worktreePath: `/tmp/${id}`, branch, createdAt, lastActiveAt: createdAt,
    tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null, enforcementTier: 'T3', pid: null, launchArgs: null,
  };
}

describe('buildConflictGraph', () => {
  test('a conflicting pair produces a bidirectional edge', () => {
    const graph = buildConflictGraph([trial({ branches: ['cw/a', 'cw/b'], result: 'conflict' })]);
    expect(graph.get('cw/a')?.has('cw/b')).toBe(true);
    expect(graph.get('cw/b')?.has('cw/a')).toBe(true);
  });

  test('a clean pair produces no edge', () => {
    const graph = buildConflictGraph([trial({ branches: ['cw/a', 'cw/b'], result: 'clean' })]);
    expect(graph.get('cw/a')?.has('cw/b')).toBeFalsy();
  });

  test('only the LATEST trial for a pair counts — a later clean result clears an earlier conflict', () => {
    const graph = buildConflictGraph([
      trial({ ts: '2026-01-01T00:00:01.000Z', branches: ['cw/a', 'cw/b'], result: 'conflict' }),
      trial({ ts: '2026-01-01T00:00:02.000Z', branches: ['cw/a', 'cw/b'], result: 'clean' }),
    ]);
    expect(graph.get('cw/a')?.has('cw/b')).toBeFalsy();
  });

  test('full-integration trials are ignored — the graph is pairwise only', () => {
    const graph = buildConflictGraph([
      trial({ branches: ['cw/a', 'cw/b', 'cw/c'], result: 'conflict', pairwise: false }),
    ]);
    expect(graph.size).toBe(0);
  });

  // C1: with exactly 2 active sessions a full-integration trial carries exactly 2
  // branches, so the branch count alone cannot exclude it here — only the recorded
  // kind can. A `test_fail` full integration over 2 branches used to be read as a
  // pairwise conflict edge between them.
  test('a full-integration trial over exactly 2 branches produces no edge either', () => {
    const graph = buildConflictGraph([
      trial({ branches: ['cw/a', 'cw/b'], result: 'conflict', pairwise: false }),
    ]);
    expect(graph.size).toBe(0);
  });

  // Rows written before schema v11 have no recorded kind; the branch count is all
  // that's available for them, which is how they were already being classified.
  test('a legacy row with no recorded kind falls back to the branch count', () => {
    const pairwise = buildConflictGraph([
      trial({ branches: ['cw/a', 'cw/b'], result: 'conflict', pairwise: null }),
    ]);
    expect(pairwise.get('cw/a')?.has('cw/b')).toBe(true);

    const full = buildConflictGraph([
      trial({ branches: ['cw/a', 'cw/b', 'cw/c'], result: 'conflict', pairwise: null }),
    ]);
    expect(full.size).toBe(0);
  });
});

describe('recommendOrder', () => {
  test('sorts by fewest conflicting partners first', () => {
    const sessions = [session('s_a', 'cw/a', '2026-01-01T00:00:01.000Z'), session('s_b', 'cw/b', '2026-01-01T00:00:02.000Z'), session('s_c', 'cw/c', '2026-01-01T00:00:03.000Z')];
    // a conflicts with both b and c; b and c don't conflict with each other
    const graph = buildConflictGraph([
      trial({ branches: ['cw/a', 'cw/b'], result: 'conflict' }),
      trial({ branches: ['cw/a', 'cw/c'], result: 'conflict' }),
      trial({ branches: ['cw/b', 'cw/c'], result: 'clean' }),
    ]);
    const order = recommendOrder(sessions, graph);
    expect(order[0]?.id).not.toBe('s_a'); // degree 2, must not be first
    expect(order.map((s) => s.id)).toContain('s_a');
  });

  test('ties break by createdAt ascending', () => {
    const sessions = [session('s_b', 'cw/b', '2026-01-01T00:00:02.000Z'), session('s_a', 'cw/a', '2026-01-01T00:00:01.000Z')];
    const graph = buildConflictGraph([]); // no conflicts at all — pure tiebreak
    const order = recommendOrder(sessions, graph);
    expect(order.map((s) => s.id)).toEqual(['s_a', 's_b']);
  });
});
