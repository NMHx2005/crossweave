import { describe, expect, test } from 'bun:test';
import { buildConflictGraph, recommendOrder } from '../../src/convergence/graph.js';
import type { MergeTrialRow } from '../../src/db/repositories/merge-trial.js';
import type { SessionRow } from '../../src/db/repositories/session.js';

function trial(overrides: Partial<MergeTrialRow>): MergeTrialRow {
  return { id: 't', workspaceId: 'ws_1', ts: 'now', branches: [], result: 'clean', detail: null, ...overrides };
}

function session(id: string, branch: string, createdAt: string): SessionRow {
  return {
    id, workspaceId: 'ws_1', name: id, agentKind: 'claude', adapter: 'claude', status: 'running',
    worktreePath: `/tmp/${id}`, branch, createdAt, lastActiveAt: createdAt,
    tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
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

  test('full-integration trials (3+ branches) are ignored — the graph is pairwise only', () => {
    const graph = buildConflictGraph([trial({ branches: ['cw/a', 'cw/b', 'cw/c'], result: 'conflict' })]);
    expect(graph.size).toBe(0);
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
