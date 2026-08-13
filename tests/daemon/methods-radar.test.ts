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
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null, enforcementTier: 'T3', pid: null,
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
