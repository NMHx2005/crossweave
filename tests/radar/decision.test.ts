import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { FileClaimRepo } from '../../src/db/repositories/file-claim.js';
import { WorkspaceManager } from '../../src/domain/workspace.js';
import { SessionManager } from '../../src/domain/session.js';
import { decideBlocked } from '../../src/radar/decision.js';

describe('decideBlocked', () => {
  function seed(safeModeTier: 'T1' | 'T2' | 'T3', querierTier: 'T2' | 'T3', withCollision: boolean) {
    const db = openDatabase(':memory:');
    new WorkspaceRepo(db).insert({
      id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
      defaultIsolation: 'worktree', safeModeTier,
    });
    const sessions = new SessionRepo(db);
    sessions.insert({
      id: 's_1', workspaceId: 'ws_1', name: 's_1', agentKind: 'claude', adapter: 'claude',
      status: 'running', worktreePath: '/tmp/w/s_1', branch: 'cw/s_1', createdAt: 'now',
      lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null, enforcementTier: querierTier, pid: null,
    });
    if (withCollision) {
      sessions.insert({
        id: 's_2', workspaceId: 'ws_1', name: 's_2', agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: '/tmp/w/s_2', branch: 'cw/s_2', createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null, enforcementTier: 'T2', pid: null,
      });
      new FileClaimRepo(db).upsert({
        id: 'fc_1', sessionId: 's_2', workspaceId: 'ws_1', path: 'src/x.ts', symbol: 'foo',
        kind: 'function', headSha: 'sha', bodyHash: 'h2', firstSeen: 'now', lastSeen: 'now',
      });
    }
    return db;
  }

  function check(db: ReturnType<typeof openDatabase>) {
    const deps = {
      fileClaims: new FileClaimRepo(db),
      workspaces: new WorkspaceManager(db),
      sessions: new SessionManager(db),
    };
    return decideBlocked(deps, { workspaceId: 'ws_1', sessionId: 's_1', path: 'src/x.ts', symbol: 'foo' });
  }

  test('T2 workspace + T2 querying session + collision: blocked', () => {
    expect(check(seed('T2', 'T2', true)).blocked).toBe(true);
  });

  test('T3 workspace (advisory-only) + T2 querying session + collision: not blocked', () => {
    expect(check(seed('T3', 'T2', true)).blocked).toBe(false);
  });

  test('T2 workspace + T3 querying session (cannot intercept anything) + collision: not blocked', () => {
    expect(check(seed('T2', 'T3', true)).blocked).toBe(false);
  });

  test('T2 workspace + T2 querying session + no collision: not blocked', () => {
    const result = check(seed('T2', 'T2', false));
    expect(result.blocked).toBe(false);
    expect(result.collisions).toHaveLength(0);
  });

  test('T1 workspace + T2 querying session + collision: blocked (T1 is not settable via setSafeMode until Task 5, but the formula itself already treats it as blocking-capable, not advisory)', () => {
    expect(check(seed('T1', 'T2', true)).blocked).toBe(true);
  });
});
