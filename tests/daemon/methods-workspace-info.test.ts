import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';

const ctx = { notify: () => undefined, onClose: () => undefined };

describe('workspace.info RPC', () => {
  test('enriches WorkspaceManager.info() with real disk usage from measureWorktrees', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'cw-wsinfo-'));
    try {
      await writeFile(join(worktree, 'payload.bin'), Buffer.alloc(4096));

      const db = openDatabase(':memory:');
      new WorkspaceRepo(db).insert({
        id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
        defaultIsolation: 'worktree', safeModeTier: 'T2',
      });
      new SessionRepo(db).insert({
        id: 's_1', workspaceId: 'ws_1', name: 's_1', agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: worktree, branch: 'cw/s_1', createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costBudgetUsd: null,
        costSpentUsd: 0, enforcementTier: 'T2', pid: null,
      });

      const methods = buildMethods(db, '/tmp/w');
      const result = (await methods['workspace.info']!({ id: 'ws_1' }, ctx)) as {
        workspace: { id: string };
        sessions: unknown[];
        disk: { usedBytes: number; limitBytes: number };
      };

      // `WorkspaceManager.info()`'s own shape (workspace, sessions) is untouched...
      expect(result.workspace.id).toBe('ws_1');
      expect(result.sessions).toHaveLength(1);
      // ...and `disk` is real measured usage, not a placeholder: at least the 4096
      // bytes just written, and the real configured per-workspace limit.
      expect(result.disk.usedBytes).toBeGreaterThanOrEqual(4096);
      expect(result.disk.limitBytes).toBe(DEFAULT_CONFIG.disk.perWorkspaceBytes);
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test('workspace with no sessions reports zero disk usage, not an error', async () => {
    const db = openDatabase(':memory:');
    new WorkspaceRepo(db).insert({
      id: 'ws_2', name: 'empty', rootPath: '/tmp/empty', createdAt: 'now',
      defaultIsolation: 'worktree', safeModeTier: 'T2',
    });

    const methods = buildMethods(db, '/tmp/empty');
    const result = (await methods['workspace.info']!({ id: 'ws_2' }, ctx)) as {
      disk: { usedBytes: number; limitBytes: number };
    };
    expect(result.disk.usedBytes).toBe(0);
    expect(result.disk.limitBytes).toBe(DEFAULT_CONFIG.disk.perWorkspaceBytes);
  });
});
