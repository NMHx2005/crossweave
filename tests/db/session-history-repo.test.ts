import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { SessionHistoryRepo, type SessionHistoryRow } from '../../src/db/repositories/session-history.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';

function row(overrides: Partial<SessionHistoryRow> & { id: string }): SessionHistoryRow {
  return {
    workspaceId: 'ws_1',
    sessionId: 's_1',
    name: 'a',
    agentKind: 'claude',
    branch: 'cw/a',
    finalStatus: 'landed',
    createdAt: '2026-09-28T00:00:00.000Z',
    endedAt: '2026-09-28T01:00:00.000Z',
    tokenSpent: 100,
    costSpentUsd: 0.5,
    note: null,
    ...overrides,
  };
}

describe('SessionHistoryRepo', () => {
  test('record() then listByWorkspace() returns it back', () => {
    const db = openDatabase(':memory:');
    new WorkspaceRepo(db).insert({
      id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
      defaultIsolation: 'worktree', safeModeTier: 'T1',
    });
    const repo = new SessionHistoryRepo(db);
    repo.record(row({ id: 'h_1' }));
    expect(repo.listByWorkspace('ws_1')).toEqual([row({ id: 'h_1' })]);
    db.close();
  });

  test('listByWorkspace is newest-ended first and scoped to the workspace', () => {
    const db = openDatabase(':memory:');
    const workspaces = new WorkspaceRepo(db);
    workspaces.insert({
      id: 'ws_1', name: 'w1', rootPath: '/tmp/w1', createdAt: 'now',
      defaultIsolation: 'worktree', safeModeTier: 'T1',
    });
    workspaces.insert({
      id: 'ws_2', name: 'w2', rootPath: '/tmp/w2', createdAt: 'now',
      defaultIsolation: 'worktree', safeModeTier: 'T1',
    });
    const repo = new SessionHistoryRepo(db);
    repo.record(row({ id: 'h_1', name: 'first', endedAt: '2026-09-28T01:00:00.000Z' }));
    repo.record(row({ id: 'h_2', name: 'second', endedAt: '2026-09-28T02:00:00.000Z' }));
    repo.record(row({ id: 'h_3', workspaceId: 'ws_2', name: 'other-workspace', endedAt: '2026-09-28T03:00:00.000Z' }));

    const names = repo.listByWorkspace('ws_1').map((r) => r.name);
    expect(names).toEqual(['second', 'first']);
    db.close();
  });

  test('listByWorkspace caps at limit (default 50)', () => {
    const db = openDatabase(':memory:');
    new WorkspaceRepo(db).insert({
      id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
      defaultIsolation: 'worktree', safeModeTier: 'T1',
    });
    const repo = new SessionHistoryRepo(db);
    for (let i = 0; i < 5; i += 1) {
      repo.record(row({ id: `h_${i}`, name: `s${i}`, endedAt: `2026-09-28T0${i}:00:00.000Z` }));
    }
    expect(repo.listByWorkspace('ws_1', 2)).toHaveLength(2);
    expect(repo.listByWorkspace('ws_1', 2).map((r) => r.name)).toEqual(['s4', 's3']);
  });

  test('the migration adds the session_history table', () => {
    const db = openDatabase(':memory:');
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
    expect(tables).toContain('session_history');
    db.close();
  });
});
