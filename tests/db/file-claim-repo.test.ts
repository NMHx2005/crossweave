import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { FileClaimRepo, type FileClaimRow } from '../../src/db/repositories/file-claim.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';

function seed(db: ReturnType<typeof openDatabase>) {
  const workspaces = new WorkspaceRepo(db);
  const sessions = new SessionRepo(db);
  workspaces.insert({
    id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
    defaultIsolation: 'worktree', safeModeTier: 'T1',
  });
  sessions.insert({
    id: 's_1', workspaceId: 'ws_1', name: 'a', agentKind: 'claude', adapter: 'claude',
    status: 'idle', worktreePath: '/tmp/w/a', branch: 'cw/a', createdAt: 'now',
    lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null, enforcementTier: 'T3', pid: null,
  });
  return { workspaces, sessions };
}

function row(overrides: Partial<FileClaimRow> = {}): FileClaimRow {
  return {
    id: 'fc_1', sessionId: 's_1', workspaceId: 'ws_1', path: 'src/x.ts',
    symbol: 'foo', kind: 'function', headSha: 'abc123', bodyHash: 'hash1',
    firstSeen: 'now', lastSeen: 'now', ...overrides,
  };
}

describe('FileClaimRepo', () => {
  test('upsert inserts a new claim, then updates the same one in place', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const repo = new FileClaimRepo(db);

    repo.upsert(row());
    expect(repo.listBySession('s_1')).toHaveLength(1);

    repo.upsert(row({ bodyHash: 'hash2', lastSeen: 'later' }));
    const rows = repo.listBySession('s_1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.bodyHash).toBe('hash2');
  });

  test('upsert treats NULL symbol claims as distinct from symbol claims on the same path', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const repo = new FileClaimRepo(db);

    repo.upsert(row({ id: 'fc_1', symbol: null, kind: 'file' }));
    repo.upsert(row({ id: 'fc_1', symbol: null, kind: 'file', bodyHash: 'hash2' }));
    expect(repo.listBySession('s_1')).toHaveLength(1);

    repo.upsert(row({ id: 'fc_2', symbol: 'foo' }));
    expect(repo.listBySession('s_1')).toHaveLength(2);
  });

  test('deleteOne removes exactly the matching claim', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const repo = new FileClaimRepo(db);
    repo.upsert(row({ id: 'fc_1', symbol: 'foo' }));
    repo.upsert(row({ id: 'fc_2', symbol: 'bar' }));

    repo.deleteOne('s_1', 'src/x.ts', 'foo');
    const rows = repo.listBySession('s_1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.symbol).toBe('bar');
  });

  test('listByWorkspacePath finds claims from every session on that path', () => {
    const db = openDatabase(':memory:');
    const { sessions } = seed(db);
    sessions.insert({
      id: 's_2', workspaceId: 'ws_1', name: 'b', agentKind: 'claude', adapter: 'claude',
      status: 'idle', worktreePath: '/tmp/w/b', branch: 'cw/b', createdAt: 'now',
      lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null, enforcementTier: 'T3', pid: null,
    });
    const repo = new FileClaimRepo(db);
    repo.upsert(row({ id: 'fc_1', sessionId: 's_1' }));
    repo.upsert(row({ id: 'fc_2', sessionId: 's_2', bodyHash: 'other' }));

    expect(repo.listByWorkspacePath('ws_1', 'src/x.ts')).toHaveLength(2);
  });

  test('deleteBySession clears every claim for that session', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const repo = new FileClaimRepo(db);
    repo.upsert(row({ id: 'fc_1', symbol: 'foo' }));
    repo.upsert(row({ id: 'fc_2', symbol: 'bar' }));
    repo.deleteBySession('s_1');
    expect(repo.listBySession('s_1')).toHaveLength(0);
  });
});
