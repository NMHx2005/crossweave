import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { LeaseRepo, type LeaseKind } from '../../src/db/repositories/lease.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';

const ctx = { notify: () => undefined, onClose: () => undefined };

describe('session.list lease visibility', () => {
  test('enriches leased sessions and leaves unleased sessions without a summary', async () => {
    const db = openDatabase(':memory:');
    new WorkspaceRepo(db).insert({
      id: 'ws_1', name: 'demo', rootPath: '/tmp/demo', createdAt: 'now',
      defaultIsolation: 'worktree', safeModeTier: 'T2',
    });
    const sessions = new SessionRepo(db);
    for (const id of ['s_leased', 's_idle']) {
      sessions.insert({
        id, workspaceId: 'ws_1', name: id, agentKind: 'claude', adapter: 'claude',
        status: id === 's_leased' ? 'running' : 'idle',
        worktreePath: `/tmp/demo/${id}`, branch: `cw/${id}`, createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costBudgetUsd: null,
        costSpentUsd: 0, enforcementTier: 'T2', pid: null,
      });
    }

    const config = {
      ...DEFAULT_CONFIG,
      db: { strategy: 'schema' as const, url: 'postgres://localhost/app' },
    };
    const methods = buildMethods(db, '/tmp/demo', undefined, config);
    const leases = new LeaseRepo(db);
    const insert = (kind: LeaseKind, value: string, releasedAt: string | null = null) => {
      leases.insert({
        id: `lease_${kind}_${releasedAt ?? 'active'}`,
        sessionId: 's_leased',
        kind,
        value,
        acquiredAt: '2026-09-15T00:00:00.000Z',
        releasedAt,
      });
    };
    insert('port', '43000');
    insert('docker', 'cw_s_leased');
    insert('cache', '/tmp/demo/.crossweave/cache/s_leased');
    insert('db', 'cw_old', '2026-09-15T00:01:00.000Z');
    insert('db', 'cw_s_leased');

    const rows = await methods['session.list']!({ workspaceId: 'ws_1' }, ctx) as Array<{
      id: string;
      leases?: {
        portBase: number | null;
        composeProject: string | null;
        cachePath: string | null;
        dbStrategy: 'none' | 'schema' | 'file-copy';
        dbValue: string | null;
      };
    }>;

    expect(rows.find((row) => row.id === 's_leased')?.leases).toEqual({
      portBase: 43000,
      composeProject: 'cw_s_leased',
      cachePath: '/tmp/demo/.crossweave/cache/s_leased',
      dbStrategy: 'schema',
      dbValue: 'cw_s_leased',
    });
    expect(rows.find((row) => row.id === 's_idle')).not.toHaveProperty('leases');
    db.close();
  });
});
