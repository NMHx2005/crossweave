import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';

function seed() {
  const db = openDatabase(':memory:');
  new WorkspaceRepo(db).insert({
    id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
    defaultIsolation: 'worktree', safeModeTier: 'T2',
  });
  const sessions = new SessionRepo(db);
  sessions.insert({
    id: 's_1', workspaceId: 'ws_1', name: 's_1', agentKind: 'claude', adapter: 'claude',
    status: 'running', worktreePath: '/tmp/w/s_1', branch: 'cw/s_1', createdAt: 'now',
    lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costBudgetUsd: null,
    costSpentUsd: 0, enforcementTier: 'T2', pid: null,
  });
  return { db, sessions };
}

const ctx = { notify: () => undefined, onClose: () => undefined };

describe('session.reportUsage RPC', () => {
  test('writes tokensUsed and costUsd to the session row', async () => {
    const { db, sessions } = seed();
    const methods = buildMethods(db, '/tmp/w');
    const result = await methods['session.reportUsage']!(
      { sessionId: 's_1', tokensUsed: 16700, costUsd: 0.0123 }, ctx,
    );
    expect(result).toEqual({ ok: true });
    const row = sessions.findById('s_1')!;
    expect(row.tokenSpent).toBe(16700);
    expect(row.costSpentUsd).toBeCloseTo(0.0123);
  });

  test('tokensUsed only: costSpentUsd stays at its previous value', async () => {
    const { db, sessions } = seed();
    const methods = buildMethods(db, '/tmp/w');
    await methods['session.reportUsage']!({ sessionId: 's_1', tokensUsed: 500 }, ctx);
    const row = sessions.findById('s_1')!;
    expect(row.tokenSpent).toBe(500);
    expect(row.costSpentUsd).toBe(0);
  });

  test('an unknown sessionId does not throw', async () => {
    const { db } = seed();
    const methods = buildMethods(db, '/tmp/w');
    const result = await methods['session.reportUsage']!({ sessionId: 's_ghost', tokensUsed: 1 }, ctx);
    expect(result).toEqual({ ok: true });
  });

  test('missing sessionId param throws INVALID_PARAMS', async () => {
    const { db } = seed();
    const methods = buildMethods(db, '/tmp/w');
    await expect(methods['session.reportUsage']!({}, ctx)).rejects.toThrow();
  });
});

describe('session.new RPC: budget params', () => {
  test('budgetTokens/budgetUsd reach the stored row through the RPC layer, not just SessionManager.create directly', async () => {
    const db = openDatabase(':memory:');
    new WorkspaceRepo(db).insert({
      id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
      defaultIsolation: 'worktree', safeModeTier: 'T2',
    });
    const methods = buildMethods(db, '/tmp/w', () => ({
      kind: 'claude', enforcementTier: 'T2',
      spawn: () => { throw new Error('not used in this test'); },
    }));
    const result = (await methods['session.new']!(
      { workspaceId: 'ws_1', name: 'budgeted', agent: 'claude', worktree: false, budgetTokens: 100000, budgetUsd: 5 },
      ctx,
    )) as { tokenBudget: number | null; costBudgetUsd: number | null };
    expect(result.tokenBudget).toBe(100000);
    expect(result.costBudgetUsd).toBe(5);
  });

  test('omitted budget params leave both budgets null through the RPC layer', async () => {
    const db = openDatabase(':memory:');
    new WorkspaceRepo(db).insert({
      id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
      defaultIsolation: 'worktree', safeModeTier: 'T2',
    });
    const methods = buildMethods(db, '/tmp/w', () => ({
      kind: 'claude', enforcementTier: 'T2',
      spawn: () => { throw new Error('not used in this test'); },
    }));
    const result = (await methods['session.new']!(
      { workspaceId: 'ws_1', name: 'unbudgeted', agent: 'claude', worktree: false },
      ctx,
    )) as { tokenBudget: number | null; costBudgetUsd: number | null };
    expect(result.tokenBudget).toBeNull();
    expect(result.costBudgetUsd).toBeNull();
  });
});


describe('usage.summary RPC', () => {
  function seedSummary() {
    const db = openDatabase(':memory:');
    new WorkspaceRepo(db).insert({
      id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: '2026-09-24T00:00:00.000Z',
      defaultIsolation: 'worktree', safeModeTier: 'T2',
    });
    const sessions = new SessionRepo(db);
    sessions.insert({
      id: 's_1', workspaceId: 'ws_1', name: 'a', agentKind: 'claude', adapter: 'claude',
      status: 'running', worktreePath: null, branch: null, createdAt: '2026-09-24T10:00:00.000Z',
      lastActiveAt: '2026-09-24T10:00:00.000Z', tokenBudget: null, tokenSpent: 100, costBudgetUsd: null, costSpentUsd: 0.01, enforcementTier: 'T2', pid: null,
    });
    sessions.insert({
      id: 's_2', workspaceId: 'ws_1', name: 'b', agentKind: 'claude', adapter: 'claude',
      status: 'running', worktreePath: null, branch: null, createdAt: '2026-09-24T12:00:00.000Z',
      lastActiveAt: '2026-09-24T12:00:00.000Z', tokenBudget: null, tokenSpent: 200, costBudgetUsd: null, costSpentUsd: 0.02, enforcementTier: 'T2', pid: null,
    });
    return { db };
  }

  test('returns summaries grouped by day+agent by default', async () => {
    const { db } = seedSummary();
    const methods = buildMethods(db, '/tmp/w');
    const res = await methods['usage.summary']!({ workspaceId: 'ws_1' }, ctx) as { summaries: { agentKind: string; tokens: number }[] };
    expect(res.summaries).toHaveLength(1);
    expect(res.summaries[0]!.agentKind).toBe('claude');
    expect(res.summaries[0]!.tokens).toBe(300);
  });

  test('empty workspace returns empty summaries', async () => {
    const db = openDatabase(':memory:');
    new WorkspaceRepo(db).insert({ id: 'ws_x', name: 'x', rootPath: '/tmp/x', createdAt: 'now', defaultIsolation: 'worktree', safeModeTier: 'T2' });
    const methods = buildMethods(db, '/tmp/x');
    const res = await methods['usage.summary']!({ workspaceId: 'ws_x' }, ctx) as { summaries: unknown[] };
    expect(res.summaries).toEqual([]);
  });

  test('groupBy param is respected', async () => {
    const { db } = seedSummary();
    const methods = buildMethods(db, '/tmp/w');
    const res = await methods['usage.summary']!({ workspaceId: 'ws_1', groupBy: 'day' }, ctx) as { summaries: { agentKind: string }[] };
    expect(res.summaries[0]!.agentKind).toBe('all');
  });

  test('missing workspaceId throws', async () => {
    const { db } = seedSummary();
    const methods = buildMethods(db, '/tmp/w');
    expect(() => (methods['usage.summary']! as unknown as (p: Record<string, unknown>, c: unknown) => unknown)({}, ctx)).toThrow();
  });
});
