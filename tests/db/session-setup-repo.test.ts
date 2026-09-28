import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { SessionSetupRepo } from '../../src/db/repositories/session-setup.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';

describe('SessionSetupRepo', () => {
  test('has / mark / clear, idempotently', () => {
    const db = openDatabase(':memory:');
    new WorkspaceRepo(db).insert({
      id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
      defaultIsolation: 'worktree', safeModeTier: 'T1',
    });
    new SessionRepo(db).insert({
      id: 's_1', workspaceId: 'ws_1', name: 'a', agentKind: 'claude', adapter: 'claude',
      status: 'idle', worktreePath: null, branch: null, createdAt: 'now', lastActiveAt: 'now',
      tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null,
      enforcementTier: 'T3', pid: null, launchArgs: null,
    });
    const repo = new SessionSetupRepo(db);
    expect(repo.has('s_1')).toBe(false);
    repo.mark('s_1');
    expect(repo.has('s_1')).toBe(true);
    repo.mark('s_1'); // idempotent
    expect(repo.has('s_1')).toBe(true);
    repo.clear('s_1');
    expect(repo.has('s_1')).toBe(false);
    db.close();
  });

  test('the migration adds the hooks_hash column and the session_setup table', () => {
    const db = openDatabase(':memory:');
    const columns = (db.prepare('PRAGMA table_info(config_trust)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toContain('hooks_hash');
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
    expect(tables).toContain('session_setup');
    db.close();
  });
});
