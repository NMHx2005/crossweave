import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { recordUsage } from '../../src/domain/usage.js';

describe('recordUsage', () => {
  function seed(): SessionRepo {
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
    return sessions;
  }

  test('tokens-only update leaves cost untouched', () => {
    const sessions = seed();
    recordUsage({ sessions }, { sessionId: 's_1', tokensUsed: 15500 });
    const row = sessions.findById('s_1')!;
    expect(row.tokenSpent).toBe(15500);
    expect(row.costSpentUsd).toBe(0);
  });

  test('cost-only update leaves tokens untouched', () => {
    const sessions = seed();
    recordUsage({ sessions }, { sessionId: 's_1', costUsd: 0.01234 });
    const row = sessions.findById('s_1')!;
    expect(row.costSpentUsd).toBeCloseTo(0.01234);
    expect(row.tokenSpent).toBe(0);
  });

  test('both fields update together', () => {
    const sessions = seed();
    recordUsage({ sessions }, { sessionId: 's_1', tokensUsed: 100, costUsd: 0.5 });
    const row = sessions.findById('s_1')!;
    expect(row.tokenSpent).toBe(100);
    expect(row.costSpentUsd).toBe(0.5);
  });

  test('neither field provided is a no-op', () => {
    const sessions = seed();
    recordUsage({ sessions }, { sessionId: 's_1' });
    const row = sessions.findById('s_1')!;
    expect(row.tokenSpent).toBe(0);
    expect(row.costSpentUsd).toBe(0);
  });

  test('an unknown sessionId does not throw', () => {
    const sessions = seed();
    expect(() => recordUsage({ sessions }, { sessionId: 's_ghost', tokensUsed: 1 })).not.toThrow();
  });
});
