import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionHistoryRepo, type SessionHistoryRow } from '../../src/db/repositories/session-history.js';

const ctx = { notify: () => undefined, onClose: () => undefined };

function row(overrides: Partial<SessionHistoryRow> & { id: string }): SessionHistoryRow {
  return {
    workspaceId: 'ws_1',
    sessionId: 's_1',
    name: 'a',
    agentKind: 'shell',
    branch: 'cw/a',
    finalStatus: 'landed',
    createdAt: '2026-09-28T00:00:00.000Z',
    endedAt: '2026-09-28T01:00:00.000Z',
    tokenSpent: 0,
    costSpentUsd: 0,
    note: null,
    ...overrides,
  };
}

describe('session.history RPC', () => {
  test('returns the workspace\'s history, newest first', async () => {
    const db = openDatabase(':memory:');
    new WorkspaceRepo(db).insert({
      id: 'ws_1', name: 'demo', rootPath: '/tmp/demo', createdAt: 'now',
      defaultIsolation: 'worktree', safeModeTier: 'T2',
    });
    const history = new SessionHistoryRepo(db);
    history.record(row({ id: 'h_1', name: 'first', endedAt: '2026-09-28T01:00:00.000Z' }));
    history.record(row({ id: 'h_2', name: 'second', endedAt: '2026-09-28T02:00:00.000Z' }));

    const methods = buildMethods(db, '/tmp/demo', undefined, DEFAULT_CONFIG);
    const result = (await methods['session.history']!({ workspaceId: 'ws_1' }, ctx)) as { history: SessionHistoryRow[] };

    expect(result.history.map((r) => r.name)).toEqual(['second', 'first']);
  });

  test('respects a limit param, defaulting to 50', async () => {
    const db = openDatabase(':memory:');
    new WorkspaceRepo(db).insert({
      id: 'ws_1', name: 'demo', rootPath: '/tmp/demo', createdAt: 'now',
      defaultIsolation: 'worktree', safeModeTier: 'T2',
    });
    const history = new SessionHistoryRepo(db);
    for (let i = 0; i < 3; i += 1) {
      history.record(row({ id: `h_${i}`, name: `s${i}`, endedAt: `2026-09-28T0${i}:00:00.000Z` }));
    }
    const methods = buildMethods(db, '/tmp/demo', undefined, DEFAULT_CONFIG);
    const result = (await methods['session.history']!({ workspaceId: 'ws_1', limit: 2 }, ctx)) as { history: SessionHistoryRow[] };
    expect(result.history).toHaveLength(2);
  });

  test('empty when nothing has ended yet', async () => {
    const db = openDatabase(':memory:');
    new WorkspaceRepo(db).insert({
      id: 'ws_1', name: 'demo', rootPath: '/tmp/demo', createdAt: 'now',
      defaultIsolation: 'worktree', safeModeTier: 'T2',
    });
    const methods = buildMethods(db, '/tmp/demo', undefined, DEFAULT_CONFIG);
    const result = (await methods['session.history']!({ workspaceId: 'ws_1' }, ctx)) as { history: SessionHistoryRow[] };
    expect(result.history).toEqual([]);
  });
});
