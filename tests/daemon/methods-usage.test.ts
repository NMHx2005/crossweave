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
