import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { makeGitFixture } from '../helpers/git-fixture.js';

/**
 * Regression guard for Important 2 (final-review fix wave): Task 2 wired
 * `tui.invalidate` at `session.new`/`session.kill`/`session.stop`/`session.rm`/
 * `land.session`, but Task 7's later `g` → `workspace.gc` binding never got the
 * same broadcast — so after a real `cw gc`/TUI `g`, the dashboard's panes went
 * stale (a selected session `collectGarbage` already deleted then fails
 * `SESSION_NOT_FOUND` on the next `l`/`x`/Enter). Mirrors the same
 * subscribe-then-assert pattern already used for `land.session` in
 * tests/convergence/land.test.ts.
 *
 * `collectGarbage`'s `sweepOrphans` shells out to real git (`git worktree list`),
 * so this needs a real git repo as the workspace root, not a fake path — same
 * reason tests/domain/gc.test.ts and tests/convergence/land.test.ts use
 * `makeGitFixture`.
 */
describe('workspace.gc RPC', () => {
  test('broadcasts tui.invalidate to a subscribed connection after a successful gc', async () => {
    const fixture = await makeGitFixture();
    try {
      const db = openDatabase(':memory:');
      new WorkspaceRepo(db).insert({
        id: 'ws_1', name: 'w', rootPath: fixture.root, createdAt: 'now',
        defaultIsolation: 'worktree', safeModeTier: 'T1',
      });
      const methods = buildMethods(db, fixture.root);
      const ctx = { notify: () => undefined, onClose: () => undefined };

      const broadcasts: Array<[string, unknown]> = [];
      const subscriberCtx = { notify: (m: string, p: unknown) => broadcasts.push([m, p]), onClose: () => undefined };
      await methods['daemon.subscribe']!({}, subscriberCtx);

      await methods['workspace.gc']!({ id: 'ws_1' }, ctx);

      const invalidations = broadcasts.filter(([m]) => m === 'tui.invalidate');
      expect(invalidations).toHaveLength(1);
      expect(invalidations[0]![1]).toEqual({});
    } finally {
      await fixture.cleanup();
    }
  });

  // Minor found in the Important 4 re-review: workspace.gc's fix (above) didn't
  // invalidate workspace.info's disk-usage TTL cache (Important 3's fix), so the
  // disk figure could keep showing pre-gc usage for up to DISK_USAGE_CACHE_TTL_MS
  // after a gc — contradicting the smoke checklist's "disk figure ... updates ...
  // no manual refresh needed" claim. Proven the same way as the workspace.info
  // caching test (methods-workspace-info.test.ts): grow the worktree between two
  // workspace.info calls, but this time with a workspace.gc call in between —
  // without the fix, the second workspace.info would still return the FIRST
  // (stale, pre-growth) cached figure, since it landed well within the 3s TTL.
  test('invalidates the workspace.info disk-usage cache, so a gc is reflected immediately, not after the TTL', async () => {
    const fixture = await makeGitFixture();
    const worktree = await mkdtemp(join(tmpdir(), 'cw-wsgc-cache-'));
    try {
      await writeFile(join(worktree, 'payload.bin'), Buffer.alloc(4096));

      const db = openDatabase(':memory:');
      new WorkspaceRepo(db).insert({
        id: 'ws_2', name: 'w', rootPath: fixture.root, createdAt: 'now',
        defaultIsolation: 'worktree', safeModeTier: 'T1',
      });
      new SessionRepo(db).insert({
        id: 's_1', workspaceId: 'ws_2', name: 's_1', agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: worktree, branch: 'cw/s_1', createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costBudgetUsd: null,
        costSpentUsd: 0, enforcementTier: 'T2', pid: null,
      });
      const methods = buildMethods(db, fixture.root);
      const ctx = { notify: () => undefined, onClose: () => undefined };

      const before = (await methods['workspace.info']!({ id: 'ws_2' }, ctx)) as {
        disk: { usedBytes: number };
      };
      expect(before.disk.usedBytes).toBeGreaterThanOrEqual(4096);

      // Grows the worktree well past the cached figure — s_1 is `running`, so gc
      // itself won't touch this worktree; only the cache invalidation is under test.
      await writeFile(join(worktree, 'more.bin'), Buffer.alloc(65536));
      await methods['workspace.gc']!({ id: 'ws_2' }, ctx);

      const after = (await methods['workspace.info']!({ id: 'ws_2' }, ctx)) as {
        disk: { usedBytes: number };
      };
      expect(after.disk.usedBytes).toBeGreaterThanOrEqual(before.disk.usedBytes + 65536);
    } finally {
      await fixture.cleanup();
      await rm(worktree, { recursive: true, force: true });
    }
  });
});
