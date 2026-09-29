import { describe, expect, test } from 'bun:test';
import { openDatabase, SCHEMA_VERSION } from '../../src/db/open.js';
import { TerminalRepo } from '../../src/db/repositories/terminal.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';

function setup() {
  const db = openDatabase(':memory:');
  new WorkspaceRepo(db).insert({ id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now', defaultIsolation: 'worktree', safeModeTier: 'T1' });
  const sessions = new SessionRepo(db);
  for (const id of ['s_1', 's_2']) {
    sessions.insert({
      id, workspaceId: 'ws_1', name: id, agentKind: 'claude', adapter: 'claude', status: 'idle', worktreePath: null, branch: null,
      createdAt: 'now', lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null,
      enforcementTier: 'T3', pid: null, launchArgs: null,
    });
  }
  return { db, sessions, repo: new TerminalRepo(db) };
}

describe('the terminal table', () => {
  test('is part of the schema (forward-only migration 15)', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(15);
    const { db } = setup();
    expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'terminal'").get()).not.toBeNull();
  });
});

describe('TerminalRepo', () => {
  test('insert, get and list a descriptor; no snapshot until one is taken', () => {
    const { repo } = setup();
    repo.insert({ id: 't_1', workspaceId: 'ws_1', sessionId: 's_1', createdAt: '2026-09-29T00:00:00.000Z' });
    expect(repo.get('t_1')).toEqual({ id: 't_1', workspaceId: 'ws_1', sessionId: 's_1', createdAt: '2026-09-29T00:00:00.000Z', snapshot: null, snapshotAt: null });
    expect(repo.listAll().map((r) => r.id)).toEqual(['t_1']);
  });

  test('insert is idempotent for the same id (a restored terminal keeps its row)', () => {
    const { repo } = setup();
    repo.insert({ id: 't_1', workspaceId: 'ws_1', sessionId: 's_1', createdAt: 'a' });
    repo.setSnapshot('t_1', 'output', 'b');
    repo.insert({ id: 't_1', workspaceId: 'ws_1', sessionId: 's_1', createdAt: 'later' });
    expect(repo.get('t_1')?.snapshot).toBe('output');
    expect(repo.get('t_1')?.createdAt).toBe('a');
  });

  test('a snapshot round-trips, including text that is not plain ASCII', () => {
    const { repo } = setup();
    repo.insert({ id: 't_1', workspaceId: 'ws_1', sessionId: 's_1', createdAt: 'a' });
    const text = 'tiếng Việt \x1b[31mred\x1b[0m 日本語\r\n';
    repo.setSnapshot('t_1', text, '2026-09-29T00:01:00.000Z');
    expect(repo.get('t_1')?.snapshot).toBe(text);
    expect(repo.get('t_1')?.snapshotAt).toBe('2026-09-29T00:01:00.000Z');
  });

  test('setSnapshot on a row that is gone does nothing', () => {
    const { repo } = setup();
    expect(() => repo.setSnapshot('t_missing', 'x', 'now')).not.toThrow();
    expect(repo.get('t_missing')).toBeUndefined();
  });

  test('delete removes one row; deleteBySession removes a session\'s rows only', () => {
    const { repo } = setup();
    repo.insert({ id: 't_1', workspaceId: 'ws_1', sessionId: 's_1', createdAt: 'a' });
    repo.insert({ id: 't_2', workspaceId: 'ws_1', sessionId: 's_1', createdAt: 'a' });
    repo.insert({ id: 't_3', workspaceId: 'ws_1', sessionId: 's_2', createdAt: 'a' });
    repo.delete('t_1');
    expect(repo.listAll().map((r) => r.id).sort()).toEqual(['t_2', 't_3']);
    repo.deleteBySession('s_1');
    expect(repo.listAll().map((r) => r.id)).toEqual(['t_3']);
  });

  // Deleting a session (rm, gc) must take its terminals' snapshots with it: they are output at rest.
  test('deleting the session row deletes its terminals\' rows (cascade)', () => {
    const { repo, db } = setup();
    repo.insert({ id: 't_1', workspaceId: 'ws_1', sessionId: 's_1', createdAt: 'a' });
    repo.setSnapshot('t_1', 'secret output', 'now');
    db.query('DELETE FROM session WHERE id = ?').run('s_1');
    expect(repo.get('t_1')).toBeUndefined();
  });

  test('deleteAll clears every row (persistence switched off)', () => {
    const { repo } = setup();
    repo.insert({ id: 't_1', workspaceId: 'ws_1', sessionId: 's_1', createdAt: 'a' });
    repo.insert({ id: 't_2', workspaceId: 'ws_1', sessionId: 's_2', createdAt: 'a' });
    repo.deleteAll();
    expect(repo.listAll()).toEqual([]);
  });
});
