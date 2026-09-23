import { describe, it, expect } from 'bun:test';
import { aggregateUsage } from '../../src/domain/usage-aggregate.js';
import type { SessionRow } from '../../src/db/repositories/session.js';

function row(over: Partial<SessionRow> & { createdAt: string }): SessionRow {
  const base: SessionRow = {
    id: 's1',
    workspaceId: 'ws1',
    name: 'a',
    agentKind: 'claude',
    adapter: 'claude',
    status: 'running',
    worktreePath: null,
    branch: null,
    createdAt: over.createdAt,
    lastActiveAt: over.createdAt,
    tokenBudget: null,
    tokenSpent: 0,
    costBudgetUsd: null,
    costSpentUsd: 0,
    enforcementTier: 'T2',
    pid: null,
  };
  return { ...base, ...over } as SessionRow;
}

describe('aggregateUsage', () => {
  it('empty → []', () => {
    expect(aggregateUsage([])).toEqual([]);
  });

  it('groups by day+agent by default', () => {
    const rows = [
      row({ id: '1', agentKind: 'claude', tokenSpent: 100, costSpentUsd: 0.01, createdAt: '2026-09-24T10:00:00.000Z' }),
      row({ id: '2', agentKind: 'claude', tokenSpent: 200, costSpentUsd: 0.02, createdAt: '2026-09-24T15:00:00.000Z' }),
      row({ id: '3', agentKind: 'cursor', tokenSpent: 50, costSpentUsd: 0.005, createdAt: '2026-09-24T12:00:00.000Z' }),
    ];
    const out = aggregateUsage(rows);
    expect(out).toHaveLength(2);
    const claude = out.find((x) => x.agentKind === 'claude')!;
    expect(claude!.tokens).toBe(300);
    expect(claude!.costUsd).toBeCloseTo(0.03);
    expect(claude!.sessions).toBe(2);
    expect(claude!.date).toBe('2026-09-24');
  });

  it('groupBy day merges agents', () => {
    const rows = [
      row({ id: '1', agentKind: 'claude', tokenSpent: 10, createdAt: '2026-09-24T01:00:00.000Z' }),
      row({ id: '2', agentKind: 'cursor', tokenSpent: 20, createdAt: '2026-09-24T02:00:00.000Z' }),
      row({ id: '3', agentKind: 'claude', tokenSpent: 5, createdAt: '2026-09-25T01:00:00.000Z' }),
    ];
    const out = aggregateUsage(rows, { groupBy: 'day' });
    expect(out).toHaveLength(2);
    expect(out[0]!.agentKind).toBe('all');
    expect(out[0]!.tokens).toBe(30);
    expect(out[1]!.tokens).toBe(5);
  });

  it('groupBy agent merges days', () => {
    const rows = [
      row({ id: '1', agentKind: 'claude', tokenSpent: 10, createdAt: '2026-09-24T01:00:00.000Z' }),
      row({ id: '2', agentKind: 'claude', tokenSpent: 20, createdAt: '2026-09-25T01:00:00.000Z' }),
      row({ id: '3', agentKind: 'cursor', tokenSpent: 7, createdAt: '2026-09-24T01:00:00.000Z' }),
    ];
    const out = aggregateUsage(rows, { groupBy: 'agent' });
    expect(out).toHaveLength(2);
    const claude2 = out.find((x) => x.agentKind === 'claude')!;
    expect(claude2.date).toBe('all');
    expect(claude2.tokens).toBe(30);
    expect(claude2.sessions).toBe(2);
  });
});
