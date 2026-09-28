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

  test('markedIds reads every marked session in one query', () => {
    const db = openDatabase(':memory:');
    new WorkspaceRepo(db).insert({
      id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
      defaultIsolation: 'worktree', safeModeTier: 'T1',
    });
    const sessions = new SessionRepo(db);
    for (const id of ['s_1', 's_2']) {
      sessions.insert({
        id, workspaceId: 'ws_1', name: id, agentKind: 'claude', adapter: 'claude',
        status: 'idle', worktreePath: null, branch: null, createdAt: 'now', lastActiveAt: 'now',
        tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null,
        enforcementTier: 'T3', pid: null, launchArgs: null,
      });
    }
    const repo = new SessionSetupRepo(db);
    repo.mark('s_1');
    expect(repo.markedIds()).toEqual(new Set(['s_1']));
    repo.mark('s_2');
    expect(repo.markedIds()).toEqual(new Set(['s_1', 's_2']));
    repo.clear('s_1');
    expect(repo.markedIds()).toEqual(new Set(['s_2']));
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

  describe('exit code tracking', () => {
    function setup(db: ReturnType<typeof openDatabase>): SessionSetupRepo {
      new WorkspaceRepo(db).insert({
        id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
        defaultIsolation: 'worktree', safeModeTier: 'T1',
      });
      const sessions = new SessionRepo(db);
      for (const id of ['s_1', 's_2']) {
        sessions.insert({
          id, workspaceId: 'ws_1', name: id, agentKind: 'claude', adapter: 'claude',
          status: 'idle', worktreePath: null, branch: null, createdAt: 'now', lastActiveAt: 'now',
          tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null,
          enforcementTier: 'T3', pid: null, launchArgs: null,
        });
      }
      return new SessionSetupRepo(db);
    }

    test('exitCode is null until recordExitCode is called', () => {
      const db = openDatabase(':memory:');
      const repo = setup(db);
      repo.mark('s_1');
      expect(repo.exitCode('s_1')).toBeNull();
      db.close();
    });

    test('recordExitCode sets it, and overwrites a previous value (e.g. cw session setup re-run)', () => {
      const db = openDatabase(':memory:');
      const repo = setup(db);
      repo.mark('s_1');
      repo.recordExitCode('s_1', 1);
      expect(repo.exitCode('s_1')).toBe(1);
      repo.recordExitCode('s_1', 0);
      expect(repo.exitCode('s_1')).toBe(0);
      db.close();
    });

    test('recordExitCode on a session never marked is a no-op, not an error', () => {
      const db = openDatabase(':memory:');
      const repo = setup(db);
      expect(() => repo.recordExitCode('s_1', 1)).not.toThrow();
      expect(repo.exitCode('s_1')).toBeNull();
      db.close();
    });

    test('clear() resets exitCode along with the once-marker', () => {
      const db = openDatabase(':memory:');
      const repo = setup(db);
      repo.mark('s_1');
      repo.recordExitCode('s_1', 1);
      repo.clear('s_1');
      expect(repo.has('s_1')).toBe(false);
      expect(repo.exitCode('s_1')).toBeNull();
      db.close();
    });

    test('failedIds is only sessions with a nonzero recorded exit code', () => {
      const db = openDatabase(':memory:');
      const repo = setup(db);
      repo.mark('s_1');
      repo.mark('s_2');
      expect(repo.failedIds()).toEqual(new Set());
      repo.recordExitCode('s_1', 0);
      expect(repo.failedIds()).toEqual(new Set());
      repo.recordExitCode('s_2', 1);
      expect(repo.failedIds()).toEqual(new Set(['s_2']));
      db.close();
    });
  });
});
