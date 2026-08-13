import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { FileClaimRepo, type FileClaimRow } from '../../src/db/repositories/file-claim.js';
import { checkCollisions } from '../../src/radar/collisions.js';

function seed(db: ReturnType<typeof openDatabase>) {
  new WorkspaceRepo(db).insert({
    id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
    defaultIsolation: 'worktree', safeModeTier: 'T1',
  });
  const sessions = new SessionRepo(db);
  for (const id of ['s_1', 's_2', 's_3']) {
    sessions.insert({
      id, workspaceId: 'ws_1', name: id, agentKind: 'claude', adapter: 'claude',
      status: 'running', worktreePath: `/tmp/w/${id}`, branch: `cw/${id}`, createdAt: 'now',
      lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null, enforcementTier: 'T3', pid: null,
    });
  }
}

function claim(overrides: Partial<FileClaimRow>): FileClaimRow {
  return {
    id: overrides.id ?? 'fc_x', sessionId: 's_1', workspaceId: 'ws_1', path: 'src/x.ts',
    symbol: 'foo', kind: 'function', headSha: 'sha', bodyHash: 'h1',
    firstSeen: 'now', lastSeen: 'now', ...overrides,
  };
}

describe('checkCollisions', () => {
  test('two sessions with divergent claims on the same symbol collide', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const claims = new FileClaimRepo(db);
    claims.upsert(claim({ id: 'fc_1', sessionId: 's_1', bodyHash: 'h1' }));
    claims.upsert(claim({ id: 'fc_2', sessionId: 's_2', bodyHash: 'h2' }));

    const found = checkCollisions(claims, { workspaceId: 'ws_1', sessionId: 's_1', path: 'src/x.ts', symbol: 'foo' });
    expect(found).toHaveLength(1);
    expect(found[0]?.sessionId).toBe('s_2');
  });

  test('claims on different symbols in the same file do not collide', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const claims = new FileClaimRepo(db);
    claims.upsert(claim({ id: 'fc_1', sessionId: 's_1', symbol: 'foo', bodyHash: 'h1' }));
    claims.upsert(claim({ id: 'fc_2', sessionId: 's_2', symbol: 'bar', bodyHash: 'h2' }));

    expect(checkCollisions(claims, { workspaceId: 'ws_1', sessionId: 's_1', path: 'src/x.ts', symbol: 'foo' })).toHaveLength(0);
  });

  test('a file-level query (no symbol) matches a symbol-level claim from another session on the same path', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const claims = new FileClaimRepo(db);
    claims.upsert(claim({ id: 'fc_1', sessionId: 's_1', symbol: null, kind: 'file', bodyHash: 'h1' }));
    claims.upsert(claim({ id: 'fc_2', sessionId: 's_2', symbol: 'foo', bodyHash: 'h2' }));

    const found = checkCollisions(claims, { workspaceId: 'ws_1', sessionId: 's_1', path: 'src/x.ts' });
    expect(found).toHaveLength(1);
    expect(found[0]?.sessionId).toBe('s_2');
  });

  test('the querying session itself is never returned as a collision', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const claims = new FileClaimRepo(db);
    claims.upsert(claim({ id: 'fc_1', sessionId: 's_1', bodyHash: 'h1' }));

    expect(checkCollisions(claims, { workspaceId: 'ws_1', sessionId: 's_1', path: 'src/x.ts', symbol: 'foo' })).toHaveLength(0);
  });

  test('a third, unrelated session on a different path never appears', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const claims = new FileClaimRepo(db);
    claims.upsert(claim({ id: 'fc_1', sessionId: 's_1', bodyHash: 'h1' }));
    claims.upsert(claim({ id: 'fc_2', sessionId: 's_3', path: 'src/y.ts', symbol: 'baz', bodyHash: 'h3' }));

    const found = checkCollisions(claims, { workspaceId: 'ws_1', sessionId: 's_1', path: 'src/x.ts', symbol: 'foo' });
    expect(found.map((c) => c.sessionId)).not.toContain('s_3');
  });
});
