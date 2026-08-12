import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { FileClaimRepo } from '../../src/db/repositories/file-claim.js';

describe('radar.check RPC', () => {
  test('reports a collision written directly to file_claim', async () => {
    const db = openDatabase(':memory:');
    new WorkspaceRepo(db).insert({
      id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
      defaultIsolation: 'worktree', safeModeTier: 'T1',
    });
    const sessions = new SessionRepo(db);
    for (const id of ['s_1', 's_2']) {
      sessions.insert({
        id, workspaceId: 'ws_1', name: id, agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: `/tmp/w/${id}`, branch: `cw/${id}`, createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
      });
    }
    new FileClaimRepo(db).upsert({
      id: 'fc_1', sessionId: 's_2', workspaceId: 'ws_1', path: 'src/x.ts', symbol: 'foo',
      kind: 'function', headSha: 'sha', bodyHash: 'h2', firstSeen: 'now', lastSeen: 'now',
    });

    const methods = buildMethods(db, '/tmp/w');
    const result = (await methods['radar.check']!(
      { workspaceId: 'ws_1', sessionId: 's_1', path: 'src/x.ts', symbol: 'foo' },
      { notify: () => undefined, onClose: () => undefined },
    )) as { collisions: unknown[]; blocked: boolean };

    expect(result.collisions).toHaveLength(1);
    // s_1's own enforcementTier is T3 (an opaque adapter that cannot intercept
    // anything), so it can never be blocked no matter the workspace's Safe Mode.
    expect(result.blocked).toBe(false);
  });
});

describe('radar.check RPC: blocked', () => {
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
      lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: querierTier, pid: null,
    });
    if (withCollision) {
      sessions.insert({
        id: 's_2', workspaceId: 'ws_1', name: 's_2', agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: '/tmp/w/s_2', branch: 'cw/s_2', createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T2', pid: null,
      });
      new FileClaimRepo(db).upsert({
        id: 'fc_1', sessionId: 's_2', workspaceId: 'ws_1', path: 'src/x.ts', symbol: 'foo',
        kind: 'function', headSha: 'sha', bodyHash: 'h2', firstSeen: 'now', lastSeen: 'now',
      });
    }
    return db;
  }

  async function check(db: ReturnType<typeof openDatabase>): Promise<{ collisions: unknown[]; blocked: boolean }> {
    const methods = buildMethods(db, '/tmp/w');
    return methods['radar.check']!(
      { workspaceId: 'ws_1', sessionId: 's_1', path: 'src/x.ts', symbol: 'foo' },
      { notify: () => undefined, onClose: () => undefined },
    ) as Promise<{ collisions: unknown[]; blocked: boolean }>;
  }

  test('T2 workspace + T2 querying session + collision: blocked', async () => {
    expect((await check(seed('T2', 'T2', true))).blocked).toBe(true);
  });

  test('T3 workspace (advisory-only) + T2 querying session + collision: not blocked', async () => {
    expect((await check(seed('T3', 'T2', true))).blocked).toBe(false);
  });

  test('T2 workspace + T3 querying session (cannot intercept anything) + collision: not blocked', async () => {
    expect((await check(seed('T2', 'T3', true))).blocked).toBe(false);
  });

  test('T2 workspace + T2 querying session + no collision: not blocked', async () => {
    const result = await check(seed('T2', 'T2', false));
    expect(result.blocked).toBe(false);
    expect(result.collisions).toHaveLength(0);
  });

  test('T1 workspace + T2 querying session + collision: blocked (T1 is unreachable via setSafeMode, but the blocked formula still treats it as blocking-capable, not merely advisory)', async () => {
    expect((await check(seed('T1', 'T2', true))).blocked).toBe(true);
  });
});
