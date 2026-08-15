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

  test('excludes the integration/scratch session\'s bytes from usedBytes, same as info.sessions already excludes it from the list', async () => {
    const normalWorktree = await mkdtemp(join(tmpdir(), 'cw-wsinfo-normal-'));
    const integrationWorktree = await mkdtemp(join(tmpdir(), 'cw-wsinfo-integration-'));
    try {
      await writeFile(join(normalWorktree, 'payload.bin'), Buffer.alloc(4096));
      // Deliberately larger than the normal session's file: if the integration
      // session's bytes leaked into the sum, this test would still pass on a
      // >=4096 assertion, so it has to actually outweigh the normal session's
      // bytes for an equality/upper-bound assertion to catch a regression.
      await writeFile(join(integrationWorktree, 'payload.bin'), Buffer.alloc(65536));

      const db = openDatabase(':memory:');
      new WorkspaceRepo(db).insert({
        id: 'ws_3', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
        defaultIsolation: 'worktree', safeModeTier: 'T2',
      });
      const sessions = new SessionRepo(db);
      sessions.insert({
        id: 's_normal', workspaceId: 'ws_3', name: 's_normal', agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: normalWorktree, branch: 'cw/s_normal', createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costBudgetUsd: null,
        costSpentUsd: 0, enforcementTier: 'T2', pid: null,
      });
      // Same agentKind/adapter/name shape WorkspaceManager.info()'s own regression
      // test (tests/domain/workspace.test.ts) uses for this session kind.
      sessions.insert({
        id: 's_integration', workspaceId: 'ws_3', name: '__integration__', agentKind: 'integration',
        adapter: 'integration', status: 'idle', worktreePath: integrationWorktree, branch: 'cw/integration',
        createdAt: 'now', lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costBudgetUsd: null,
        costSpentUsd: 0, enforcementTier: 'T3', pid: null,
      });

      const methods = buildMethods(db, '/tmp/w');
      const result = (await methods['workspace.info']!({ id: 'ws_3' }, ctx)) as {
        sessions: unknown[];
        disk: { usedBytes: number };
      };

      expect(result.sessions).toHaveLength(1);
      expect(result.disk.usedBytes).toBeGreaterThanOrEqual(4096);
      expect(result.disk.usedBytes).toBeLessThan(65536);
    } finally {
      await rm(normalWorktree, { recursive: true, force: true });
      await rm(integrationWorktree, { recursive: true, force: true });
    }
  });

  // Important 3 (final-review fix wave): `measureWorktrees` is a fully synchronous
  // recursive filesystem walk that blocks the whole (single-threaded) daemon — the
  // TUI calls this handler on every `tui.invalidate`, i.e. after every session
  // mutation. A short TTL cache avoids re-walking within the same window. Proven
  // here deterministically (no clock mocking needed): grow the worktree between two
  // calls that land well within the 3s TTL, and confirm the SECOND call still
  // reports the FIRST call's (now stale) figure — i.e. it reused the cache instead
  // of re-measuring.
  test('repeated calls within the TTL window reuse the cached disk figure instead of re-measuring', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'cw-wsinfo-cache-'));
    try {
      await writeFile(join(worktree, 'payload.bin'), Buffer.alloc(4096));

      const db = openDatabase(':memory:');
      new WorkspaceRepo(db).insert({
        id: 'ws_cache', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
        defaultIsolation: 'worktree', safeModeTier: 'T2',
      });
      new SessionRepo(db).insert({
        id: 's_1', workspaceId: 'ws_cache', name: 's_1', agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: worktree, branch: 'cw/s_1', createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costBudgetUsd: null,
        costSpentUsd: 0, enforcementTier: 'T2', pid: null,
      });

      const methods = buildMethods(db, '/tmp/w');
      const first = (await methods['workspace.info']!({ id: 'ws_cache' }, ctx)) as {
        disk: { usedBytes: number };
      };
      expect(first.disk.usedBytes).toBeGreaterThanOrEqual(4096);

      // Grow the worktree well past the first measurement — if the second call
      // re-walked the filesystem, it would see this and the two figures would
      // differ.
      await writeFile(join(worktree, 'more.bin'), Buffer.alloc(65536));

      const second = (await methods['workspace.info']!({ id: 'ws_cache' }, ctx)) as {
        disk: { usedBytes: number };
      };
      expect(second.disk.usedBytes).toBe(first.disk.usedBytes);
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });
});
