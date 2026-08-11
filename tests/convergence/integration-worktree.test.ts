import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { ensureIntegrationWorktree } from '../../src/convergence/integration-worktree.js';
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
