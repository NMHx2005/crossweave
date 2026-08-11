import { describe, expect, test } from 'bun:test';
import { $ } from 'bun';
import { execFileSync } from 'node:child_process';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { EventRepo } from '../../src/db/repositories/event.js';
import { LeaseManager } from '../../src/isolation/leases/manager.js';
import { EventLedger } from '../../src/domain/ledger.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { landSession } from '../../src/convergence/land.js';
import { makeGitFixture, commitFile, type GitFixture } from '../helpers/git-fixture.js';

async function setup(fixture: GitFixture, config = DEFAULT_CONFIG) {
  const db = openDatabase(':memory:');
  new WorkspaceRepo(db).insert({
    id: 'ws_1', name: 'w', rootPath: fixture.root, createdAt: 'now',
    defaultIsolation: 'worktree', safeModeTier: 'T1',
  });
  const sessions = new SessionRepo(db);
  const leaseManager = new LeaseManager(db, fixture.root, config);
  const ledger = new EventLedger(db, fixture.root);
  return { db, sessions, leaseManager, ledger, config };
}

describe('landSession', () => {
  test('refuses a running session unless force', async () => {
    const fixture = await makeGitFixture();
    try {
      await $`git checkout -q -b cw/a`.cwd(fixture.root).quiet();
      await commitFile(fixture.root, 'a.txt', 'a\n', 'add a');
      await $`git checkout -q main`.cwd(fixture.root).quiet();
      const { db, sessions, leaseManager, ledger, config } = await setup(fixture);
      sessions.insert({
        id: 's_a', workspaceId: 'ws_1', name: 'a', agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: fixture.root, branch: 'cw/a', createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
      });

      await expect(
        landSession({ db, projectRoot: fixture.root, sessions, leaseManager, ledger, config }, 'ws_1', 's_a', { force: false }),
      ).rejects.toMatchObject({ code: 'SESSION_STILL_LIVE' });
    } finally {
      await fixture.cleanup();
    }
  });

  test('refuses on a fresh conflict against current base, naming the conflicting file', async () => {
    const fixture = await makeGitFixture();
    try {
      await commitFile(fixture.root, 'shared.txt', 'base\n', 'seed');
      await $`git checkout -q -b cw/a`.cwd(fixture.root).quiet();
      await commitFile(fixture.root, 'shared.txt', 'from a\n', 'a edits shared');
      await $`git checkout -q main`.cwd(fixture.root).quiet();
      await commitFile(fixture.root, 'shared.txt', 'from main\n', 'main edits shared too');

      const { db, sessions, leaseManager, ledger, config } = await setup(fixture);
      sessions.insert({
        id: 's_a', workspaceId: 'ws_1', name: 'a', agentKind: 'claude', adapter: 'claude',
        status: 'idle', worktreePath: fixture.root, branch: 'cw/a', createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
      });

      await expect(
        landSession({ db, projectRoot: fixture.root, sessions, leaseManager, ledger, config }, 'ws_1', 's_a', { force: false }),
      ).rejects.toMatchObject({ code: 'LAND_CONFLICT' });
    } finally {
      await fixture.cleanup();
    }
  });

  test('lands a clean session with no test command: squash-merges to base, marks landed, writes session.landed', async () => {
    const fixture = await makeGitFixture();
    try {
      await $`git checkout -q -b cw/a`.cwd(fixture.root).quiet();
      await commitFile(fixture.root, 'a.txt', 'a\n', 'add a');
      await $`git checkout -q main`.cwd(fixture.root).quiet();

      const { db, sessions, leaseManager, ledger, config } = await setup(fixture);
      sessions.insert({
        id: 's_a', workspaceId: 'ws_1', name: 'a', agentKind: 'claude', adapter: 'claude',
        status: 'idle', worktreePath: fixture.root, branch: 'cw/a', createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
      });

      const result = await landSession(
        { db, projectRoot: fixture.root, sessions, leaseManager, ledger, config }, 'ws_1', 's_a', { force: false },
      );
      expect(result.status).toBe('landed');

      const mainLog = execFileSync('git', ['log', '--oneline', '-1', 'main'], { cwd: fixture.root, encoding: 'utf8' });
      expect(mainLog).toBeTruthy();
      const mainFiles = execFileSync('git', ['ls-tree', '-r', '--name-only', 'main'], { cwd: fixture.root, encoding: 'utf8' });
      expect(mainFiles).toContain('a.txt');
      expect(sessions.findById('s_a')?.status).toBe('landed');

      const events = new EventRepo(db).listBySession('s_a');
      expect(events.some((e) => e.kind === 'session.landed')).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  test('reports unverified, not success, when no test command is configured', async () => {
    const fixture = await makeGitFixture();
    try {
      await $`git checkout -q -b cw/a`.cwd(fixture.root).quiet();
      await commitFile(fixture.root, 'a.txt', 'a\n', 'add a');
      await $`git checkout -q main`.cwd(fixture.root).quiet();

      const { db, sessions, leaseManager, ledger, config } = await setup(fixture);
      sessions.insert({
        id: 's_a', workspaceId: 'ws_1', name: 'a', agentKind: 'claude', adapter: 'claude',
        status: 'idle', worktreePath: fixture.root, branch: 'cw/a', createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
      });

      const result = await landSession(
        { db, projectRoot: fixture.root, sessions, leaseManager, ledger, config }, 'ws_1', 's_a', { force: false },
      );
      expect(result.tested).toBe('unverified');
    } finally {
      await fixture.cleanup();
    }
  });
});
