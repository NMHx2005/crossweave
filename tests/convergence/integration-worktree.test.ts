import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { ensureIntegrationWorktree, withIntegrationWorktreeLock } from '../../src/convergence/integration-worktree.js';
import { makeGitFixture, type GitFixture } from '../helpers/git-fixture.js';

describe('ensureIntegrationWorktree', () => {
  test('creates the worktree at .crossweave/integration on branch cw/integration', async () => {
    const fixture = await makeGitFixture();
    try {
      const db = openDatabase(':memory:');
      new WorkspaceRepo(db).insert({
        id: 'ws_1', name: 'w', rootPath: fixture.root, createdAt: 'now',
        defaultIsolation: 'worktree', safeModeTier: 'T1',
      });

      const handle = await ensureIntegrationWorktree(db, 'ws_1', fixture.root);
      expect(handle.path).toBe(join(fixture.root, '.crossweave', 'integration'));
      expect(handle.branch).toBe('cw/integration');
      expect(existsSync(handle.path)).toBe(true);

      const row = new SessionRepo(db).findById(handle.sessionId);
      expect(row?.agentKind).toBe('integration');
      expect(row?.name).toBe('__integration__');
    } finally {
      await fixture.cleanup();
    }
  });

  test('a second call reuses the same worktree and session row', async () => {
    const fixture = await makeGitFixture();
    try {
      const db = openDatabase(':memory:');
      new WorkspaceRepo(db).insert({
        id: 'ws_1', name: 'w', rootPath: fixture.root, createdAt: 'now',
        defaultIsolation: 'worktree', safeModeTier: 'T1',
      });

      const first = await ensureIntegrationWorktree(db, 'ws_1', fixture.root);
      const second = await ensureIntegrationWorktree(db, 'ws_1', fixture.root);
      expect(second.sessionId).toBe(first.sessionId);
      expect(new SessionRepo(db).listByWorkspace('ws_1')).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  test('concurrent calls for the same workspace coalesce into one creation', async () => {
    const fixture = await makeGitFixture();
    try {
      const db = openDatabase(':memory:');
      new WorkspaceRepo(db).insert({
        id: 'ws_1', name: 'w', rootPath: fixture.root, createdAt: 'now',
        defaultIsolation: 'worktree', safeModeTier: 'T1',
      });

      // No `await` between the two calls: both must observe the row missing and race
      // through the check-then-act unless the in-flight cache coalesces them.
      const [a, b] = await Promise.all([
        ensureIntegrationWorktree(db, 'ws_1', fixture.root),
        ensureIntegrationWorktree(db, 'ws_1', fixture.root),
      ]);
      expect(b.sessionId).toBe(a.sessionId);
      expect(new SessionRepo(db).listByWorkspace('ws_1')).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  test('recreates the worktree and session row after a crash removes the directory', async () => {
    const fixture = await makeGitFixture();
    try {
      const db = openDatabase(':memory:');
      new WorkspaceRepo(db).insert({
        id: 'ws_1', name: 'w', rootPath: fixture.root, createdAt: 'now',
        defaultIsolation: 'worktree', safeModeTier: 'T1',
      });

      const first = await ensureIntegrationWorktree(db, 'ws_1', fixture.root);
      // Simulates a crash mid-teardown: the row still points at `first.path`, but
      // nothing is there any more.
      await rm(first.path, { recursive: true, force: true });

      const second = await ensureIntegrationWorktree(db, 'ws_1', fixture.root);
      expect(second.sessionId).not.toBe(first.sessionId);
      expect(existsSync(second.path)).toBe(true);
      expect(new SessionRepo(db).listByWorkspace('ws_1')).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('withIntegrationWorktreeLock', () => {
  // Regression for the Critical cross-task bug: `ConvergenceScheduler` and
  // `landSession` both drive the SAME `.crossweave/integration` worktree with no
  // mutual exclusion between them. A real end-to-end repro (scheduler tick racing
  // a `cw land`) would be flaky — this pins the lock's own contract directly, with
  // a manually-controlled gate instead of a real sleep.

  test('serializes calls for the SAME workspace: the second does not start until the first resolves', async () => {
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;

    const first = withIntegrationWorktreeLock('ws_1', async () => {
      order.push('first-start');
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push('first-end');
    });

    // Let the first call's synchronous prefix (up to its own await) run, but no further.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['first-start']);

    const second = withIntegrationWorktreeLock('ws_1', async () => {
      order.push('second-start');
    });

    // The second call must not have started merely because it was queued — it is
    // still waiting on the first to resolve.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['first-start']);

    releaseFirst?.();
    await first;
    await second;

    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });

  test('a DIFFERENT workspace is not blocked by a still-running call for another workspace', async () => {
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;

    const first = withIntegrationWorktreeLock('ws_1', async () => {
      order.push('ws1-start');
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push('ws1-end');
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['ws1-start']);

    // A DIFFERENT workspace's call must run to completion even while ws_1's lock
    // is still held — the lock is per-workspace, not a single global mutex.
    const second = await withIntegrationWorktreeLock('ws_2', async () => {
      order.push('ws2');
      return 'done';
    });
    expect(second).toBe('done');
    expect(order).toEqual(['ws1-start', 'ws2']);

    releaseFirst?.();
    await first;
    expect(order).toEqual(['ws1-start', 'ws2', 'ws1-end']);
  });

  test('a rejection from one caller does not wedge the lock for the next caller', async () => {
    await expect(
      withIntegrationWorktreeLock('ws_3', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const result = await withIntegrationWorktreeLock('ws_3', async () => 'ok');
    expect(result).toBe('ok');
  });
});
