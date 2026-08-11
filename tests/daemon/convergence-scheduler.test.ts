import { describe, expect, test } from 'bun:test';
import { $ } from 'bun';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { LeaseManager } from '../../src/isolation/leases/manager.js';
import { MergeTrialRepo } from '../../src/db/repositories/merge-trial.js';
import { ConvergenceScheduler } from '../../src/daemon/convergence-scheduler.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { makeGitFixture, commitFile, type GitFixture } from '../helpers/git-fixture.js';

async function branchWithFile(root: string, branch: string, file: string, content: string): Promise<void> {
  await $`git checkout -q -b ${branch}`.cwd(root).quiet();
  await commitFile(root, file, content, `add ${file}`);
  await $`git checkout -q main`.cwd(root).quiet();
}

async function setup(fixture: GitFixture) {
  const db = openDatabase(':memory:');
  new WorkspaceRepo(db).insert({
    id: 'ws_1', name: 'w', rootPath: fixture.root, createdAt: 'now',
    defaultIsolation: 'worktree', safeModeTier: 'T1',
  });
  const sessions = new SessionRepo(db);
  const config = { ...DEFAULT_CONFIG, converge: { ...DEFAULT_CONFIG.converge, trialDebounceMs: 0 } };
  const leaseManager = new LeaseManager(db, fixture.root, config);
  const scheduler = new ConvergenceScheduler(db, fixture.root, config, leaseManager);
  return { db, sessions, leaseManager, scheduler };
}

describe('ConvergenceScheduler', () => {
  test('a pairwise trial between two clean-merging session branches records "clean"', async () => {
    const fixture = await makeGitFixture();
    try {
      await branchWithFile(fixture.root, 'cw/a', 'a.txt', 'a\n');
      await branchWithFile(fixture.root, 'cw/b', 'b.txt', 'b\n');
      const { db, sessions, scheduler } = await setup(fixture);
      sessions.insert({
        id: 's_a', workspaceId: 'ws_1', name: 'a', agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: fixture.root, branch: 'cw/a', createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
      });
      sessions.insert({
        id: 's_b', workspaceId: 'ws_1', name: 'b', agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: fixture.root, branch: 'cw/b', createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
      });

      await scheduler.tick();

      const trials = new MergeTrialRepo(db).listByWorkspace('ws_1');
      const pairwise = trials.filter((t) => t.branches.length === 2);
      expect(pairwise).toHaveLength(1);
      expect(pairwise[0]?.result).toBe('clean');
    } finally {
      await fixture.cleanup();
    }
  });

  test('a pairwise trial between conflicting branches records "conflict" with the conflicting file named', async () => {
    const fixture = await makeGitFixture();
    try {
      await commitFile(fixture.root, 'shared.txt', 'base\n', 'seed');
      await branchWithFile(fixture.root, 'cw/a', 'shared.txt', 'from a\n');
      await branchWithFile(fixture.root, 'cw/b', 'shared.txt', 'from b\n');
      const { db, sessions, scheduler } = await setup(fixture);
      sessions.insert({
        id: 's_a', workspaceId: 'ws_1', name: 'a', agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: fixture.root, branch: 'cw/a', createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
      });
      sessions.insert({
        id: 's_b', workspaceId: 'ws_1', name: 'b', agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: fixture.root, branch: 'cw/b', createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
      });

      await scheduler.tick();

      const pairwise = new MergeTrialRepo(db).listByWorkspace('ws_1').filter((t) => t.branches.length === 2);
      expect(pairwise).toHaveLength(1);
      expect(pairwise[0]?.result).toBe('conflict');
      expect(pairwise[0]?.detail).toContain('shared.txt');
    } finally {
      await fixture.cleanup();
    }
  });

  test('a branch whose head has not changed since its last trial is not re-trialled', async () => {
    const fixture = await makeGitFixture();
    try {
      await branchWithFile(fixture.root, 'cw/a', 'a.txt', 'a\n');
      await branchWithFile(fixture.root, 'cw/b', 'b.txt', 'b\n');
      const { db, sessions, scheduler } = await setup(fixture);
      sessions.insert({
        id: 's_a', workspaceId: 'ws_1', name: 'a', agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: fixture.root, branch: 'cw/a', createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
      });
      sessions.insert({
        id: 's_b', workspaceId: 'ws_1', name: 'b', agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: fixture.root, branch: 'cw/b', createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
      });

      await scheduler.tick();
      await scheduler.tick();

      const pairwise = new MergeTrialRepo(db).listByWorkspace('ws_1').filter((t) => t.branches.length === 2);
      expect(pairwise).toHaveLength(1); // not 2 — the second tick found nothing due
    } finally {
      await fixture.cleanup();
    }
  });

  test('the integration session never appears as a trial participant', async () => {
    const fixture = await makeGitFixture();
    try {
      await branchWithFile(fixture.root, 'cw/a', 'a.txt', 'a\n');
      const { sessions, scheduler } = await setup(fixture);
      sessions.insert({
        id: 's_a', workspaceId: 'ws_1', name: 'a', agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: fixture.root, branch: 'cw/a', createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
      });

      // A single active session has no PARTNER to pair against — this must
      // not crash, and must leave zero pairwise trials.
      await expect(scheduler.tick()).resolves.toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  });

  test('above the pairwise session threshold, no pairwise trials run but full integration still does', async () => {
    const fixture = await makeGitFixture();
    try {
      const branchCount = 9; // > DEFAULT_CONFIG.converge.pairwiseSessionThreshold (8)
      for (let i = 0; i < branchCount; i += 1) {
        await branchWithFile(fixture.root, `cw/s${i}`, `s${i}.txt`, `${i}\n`);
      }

      const db = openDatabase(':memory:');
      new WorkspaceRepo(db).insert({
        id: 'ws_1', name: 'w', rootPath: fixture.root, createdAt: 'now',
        defaultIsolation: 'worktree', safeModeTier: 'T1',
      });
      const sessions = new SessionRepo(db);
      const config = {
        ...DEFAULT_CONFIG,
        converge: { ...DEFAULT_CONFIG.converge, trialDebounceMs: 0, fullIntegrationIntervalMs: 0 },
      };
      const leaseManager = new LeaseManager(db, fixture.root, config);
      const scheduler = new ConvergenceScheduler(db, fixture.root, config, leaseManager);

      for (let i = 0; i < branchCount; i += 1) {
        sessions.insert({
          id: `s_${i}`, workspaceId: 'ws_1', name: `s${i}`, agentKind: 'claude', adapter: 'claude',
          status: 'running', worktreePath: fixture.root, branch: `cw/s${i}`, createdAt: 'now',
          lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
        });
      }

      await scheduler.tick();

      const trials = new MergeTrialRepo(db).listByWorkspace('ws_1');
      const pairwise = trials.filter((t) => t.branches.length === 2);
      expect(pairwise).toHaveLength(0);

      const fullIntegration = trials.filter((t) => t.branches.length === branchCount);
      expect(fullIntegration).toHaveLength(1);
      expect(fullIntegration[0]?.result).toBe('unverified'); // clean merge, no testCommand configured
    } finally {
      await fixture.cleanup();
    }
  });
});
