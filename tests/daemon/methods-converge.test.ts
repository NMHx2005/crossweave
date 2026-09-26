import { describe, expect, test } from 'bun:test';
import { $ } from 'bun';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { MergeTrialRepo } from '../../src/db/repositories/merge-trial.js';
import { ConfigTrustRepo } from '../../src/db/repositories/config-trust.js';
import { LeaseManager } from '../../src/isolation/leases/manager.js';
import { ConvergenceScheduler } from '../../src/daemon/convergence-scheduler.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { makeGitFixture, commitFile } from '../helpers/git-fixture.js';

/**
 * `buildMethods` runs the boot-time orphan sweep, and `converge.status` reads the base
 * HEAD — so these tests need a real git repo. They must not use `process.cwd()` for it:
 * that is the developer's own checkout, and the sweep used to reclaim every unclaimed
 * worktree `git worktree list` reported, so running this suite from a repo root
 * destroyed that repo's worktrees (uncommitted work included). A throwaway fixture is
 * the same real repo, with none of that blast radius.
 */
describe('converge.status RPC', () => {
  test('classifies every active session as unknown when no convergence trials exist', async () => {
    const fixture = await makeGitFixture();
    const db = openDatabase(':memory:');
    new WorkspaceRepo(db).insert({
      id: 'ws_1', name: 'w', rootPath: fixture.root, createdAt: 'now',
      defaultIsolation: 'worktree', safeModeTier: 'T1',
    });
    const sessions = new SessionRepo(db);
    for (const [id, name] of [['s_a', 'a'], ['s_b', 'b']] as const) {
      sessions.insert({
        id, workspaceId: 'ws_1', name, agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: tmpdir(), branch: `cw/${name}`, createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null, enforcementTier: 'T3', pid: null, launchArgs: null,
      });
    }

    try {
      const methods = buildMethods(db, fixture.root);
      const result = (await methods['converge.status']!(
        { workspaceId: 'ws_1' },
        { notify: () => undefined, onClose: () => undefined },
      )) as {
        ready: string[];
        conflictFree: string[];
        unknown: { name: string; reason: string }[];
        blocked: { name: string; reason: string }[];
      };

      expect(result.ready).toEqual([]);
      expect(result.conflictFree).toEqual([]);
      expect(result.unknown).toEqual([
        { name: 'a', reason: 'no pairwise trial with b' },
        { name: 'b', reason: 'no pairwise trial with a' },
      ]);
      expect(result.blocked).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  test('classifies sessions with fresh clean pairwise evidence as ready', async () => {
    const fixture = await makeGitFixture();
    const db = openDatabase(':memory:');
    const projectRoot = fixture.root;
    const baseHead = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: projectRoot, encoding: 'utf8',
    }).trim();
    new WorkspaceRepo(db).insert({
      id: 'ws_1', name: 'w', rootPath: projectRoot, createdAt: 'now',
      defaultIsolation: 'worktree', safeModeTier: 'T1',
    });
    const sessions = new SessionRepo(db);
    for (const [id, name] of [['s_a', 'a'], ['s_b', 'b']] as const) {
      sessions.insert({
        id, workspaceId: 'ws_1', name, agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: tmpdir(), branch: `cw/${name}`, createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null, enforcementTier: 'T3', pid: null, launchArgs: null,
      });
    }
    new MergeTrialRepo(db).insert({
      id: 'mt_1', workspaceId: 'ws_1', ts: 'now', branches: ['cw/a', 'cw/b'],
      result: 'clean', detail: null, baseHead, pairwise: true,
    });

    const methods = buildMethods(db, projectRoot);
    const result = (await methods['converge.status']!(
      { workspaceId: 'ws_1' },
      { notify: () => undefined, onClose: () => undefined },
    )) as {
      ready: string[];
      conflictFree: string[];
      unknown: { name: string; reason: string }[];
      blocked: { name: string; reason: string }[];
    };

    expect(result.ready).toEqual(['a', 'b']);
    expect(result.conflictFree).toEqual(result.ready);
    expect(result.unknown).toEqual([]);
    expect(result.blocked).toEqual([]);
    await fixture.cleanup();
  });

  // Trial history outlives sessions. Listing it all kept showing
  // `cw/alpha <-> cw/beta conflict` after both sessions were landed and removed.
  // A lone session has no peer, hence no trial, and was classified `ready` even
  // while `cw land` refused it with LAND_CONFLICT.
  test('a lone session that conflicts with the base is blocked, and ready again once resolved', async () => {
    const fixture = await makeGitFixture();
    const root = fixture.root;
    try {
      await commitFile(root, 'shared.txt', 'base\n', 'seed');
      await $`git checkout -q -b cw/solo`.cwd(root).quiet();
      await commitFile(root, 'shared.txt', 'from solo\n', 'solo edit');
      await $`git checkout -q main`.cwd(root).quiet();
      await commitFile(root, 'shared.txt', 'from main\n', 'main edit');

      const db = openDatabase(':memory:');
      new WorkspaceRepo(db).insert({
        id: 'ws_1', name: 'w', rootPath: root, createdAt: 'now',
        defaultIsolation: 'worktree', safeModeTier: 'T1',
      });
      new SessionRepo(db).insert({
        id: 's_solo', workspaceId: 'ws_1', name: 'solo', agentKind: 'claude', adapter: 'claude',
        status: 'idle', worktreePath: tmpdir(), branch: 'cw/solo', createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null, enforcementTier: 'T3', pid: null, launchArgs: null,
      });
      const methods = buildMethods(db, root);
      const status = async () => (await methods['converge.status']!(
        { workspaceId: 'ws_1' }, { notify: () => undefined, onClose: () => undefined },
      )) as { ready: string[]; blocked: { name: string; reason: string }[] };

      const before = await status();
      expect(before.ready).toEqual([]);
      expect(before.blocked).toEqual([{ name: 'solo', reason: 'conflicts with the current base: shared.txt' }]);

      // Resolve on the branch the way the LAND_CONFLICT message says to.
      await $`git checkout -q cw/solo`.cwd(root).quiet();
      await $`git merge -q -X ours main -m resolve`.cwd(root).quiet();
      await $`git checkout -q main`.cwd(root).quiet();
      const after = await status();
      expect(after.blocked).toEqual([]);
      expect(after.ready).toEqual(['solo']);
    } finally {
      await fixture.cleanup();
    }
  });

  // A session created a moment ago has no commits: landing it is a no-op, and
  // calling it "ready to land" put a green badge on a session that had done nothing.
  test('a session with no commits ahead of the base has nothing to land, not "ready"', async () => {
    const fixture = await makeGitFixture();
    const root = fixture.root;
    try {
      await $`git branch cw/fresh`.cwd(root).quiet();
      const db = openDatabase(':memory:');
      new WorkspaceRepo(db).insert({
        id: 'ws_1', name: 'w', rootPath: root, createdAt: 'now',
        defaultIsolation: 'worktree', safeModeTier: 'T1',
      });
      new SessionRepo(db).insert({
        id: 's_fresh', workspaceId: 'ws_1', name: 'fresh', agentKind: 'claude', adapter: 'claude',
        status: 'idle', worktreePath: tmpdir(), branch: 'cw/fresh', createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null, enforcementTier: 'T3', pid: null, launchArgs: null,
      });
      const methods = buildMethods(db, root);
      const status = async () => (await methods['converge.status']!(
        { workspaceId: 'ws_1' }, { notify: () => undefined, onClose: () => undefined },
      )) as { ready: string[]; empty: string[] };

      const before = await status();
      expect(before.ready).toEqual([]);
      expect(before.empty).toEqual(['fresh']);

      await $`git checkout -q cw/fresh`.cwd(root).quiet();
      await commitFile(root, 'work.txt', 'done\n', 'work');
      await $`git checkout -q main`.cwd(root).quiet();
      const after = await status();
      expect(after.empty).toEqual([]);
      expect(after.ready).toEqual(['fresh']);
    } finally {
      await fixture.cleanup();
    }
  });

  test('the pairwise matrix only lists pairs whose sessions are both still active', async () => {
    const fixture = await makeGitFixture();
    const db = openDatabase(':memory:');
    new WorkspaceRepo(db).insert({
      id: 'ws_1', name: 'w', rootPath: fixture.root, createdAt: 'now',
      defaultIsolation: 'worktree', safeModeTier: 'T1',
    });
    const sessions = new SessionRepo(db);
    for (const [id, name] of [['s_a', 'a'], ['s_b', 'b']] as const) {
      sessions.insert({
        id, workspaceId: 'ws_1', name, agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: tmpdir(), branch: `cw/${name}`, createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null, enforcementTier: 'T3', pid: null, launchArgs: null,
      });
    }
    const trials = new MergeTrialRepo(db);
    const trial = (id: string, branches: string[]) => trials.insert({
      id, workspaceId: 'ws_1', ts: 'now', branches, result: 'conflict', detail: null, baseHead: 'x', pairwise: true,
    });
    trial('mt_1', ['cw/a', 'cw/b']);
    trial('mt_2', ['cw/a', 'cw/gone']);
    trial('mt_3', ['cw/old1', 'cw/old2']);
    try {
      const methods = buildMethods(db, fixture.root);
      const result = (await methods['converge.status']!(
        { workspaceId: 'ws_1' },
        { notify: () => undefined, onClose: () => undefined },
      )) as { pairwise: { a: string; b: string }[] };
      expect(result.pairwise.map((p) => [p.a, p.b].sort().join('|'))).toEqual(['cw/a|cw/b']);
    } finally {
      await fixture.cleanup();
    }
  });

  test('reports the pairwise matrix and recommended order from seeded trial data', async () => {
    const fixture = await makeGitFixture();
    const db = openDatabase(':memory:');
    new WorkspaceRepo(db).insert({
      id: 'ws_1', name: 'w', rootPath: fixture.root, createdAt: 'now',
      defaultIsolation: 'worktree', safeModeTier: 'T1',
    });
    const sessions = new SessionRepo(db);
    // worktreePath must point at a directory that actually exists — buildMethods'
    // boot-time reconcile() marks any `running`/`waiting` session whose worktree is
    // gone as `dead`, which converge.status's active-session filter then excludes.
    sessions.insert({
      id: 's_a', workspaceId: 'ws_1', name: 'a', agentKind: 'claude', adapter: 'claude',
      status: 'running', worktreePath: tmpdir(), branch: 'cw/a', createdAt: 'now',
      lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null, enforcementTier: 'T3', pid: null, launchArgs: null,
    });
    sessions.insert({
      id: 's_b', workspaceId: 'ws_1', name: 'b', agentKind: 'claude', adapter: 'claude',
      status: 'running', worktreePath: tmpdir(), branch: 'cw/b', createdAt: 'now',
      lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null, enforcementTier: 'T3', pid: null, launchArgs: null,
    });
    new MergeTrialRepo(db).insert({
      id: 'mt_1', workspaceId: 'ws_1', ts: 'now', branches: ['cw/a', 'cw/b'],
      result: 'conflict', detail: 'x.ts', baseHead: '', pairwise: true,
    });

    const methods = buildMethods(db, fixture.root);
    const result = (await methods['converge.status']!(
      { workspaceId: 'ws_1' },
      { notify: () => undefined, onClose: () => undefined },
    )) as { pairwise: unknown[]; recommendedOrder: string[]; degraded: boolean };

    expect(result.pairwise).toHaveLength(1);
    expect(result.recommendedOrder).toEqual(['a', 'b']);
    expect(result.degraded).toBe(false);
    await fixture.cleanup();
  });

  test('reports degraded once active sessions exceed converge.pairwiseSessionThreshold', async () => {
    const fixture = await makeGitFixture();
    const db = openDatabase(':memory:');
    new WorkspaceRepo(db).insert({
      id: 'ws_1', name: 'w', rootPath: fixture.root, createdAt: 'now',
      defaultIsolation: 'worktree', safeModeTier: 'T1',
    });
    const sessions = new SessionRepo(db);
    // DEFAULT_CONFIG.converge.pairwiseSessionThreshold is 8 — 9 active sessions crosses it.
    for (let i = 0; i < 9; i += 1) {
      sessions.insert({
        id: `s_${i}`, workspaceId: 'ws_1', name: `s${i}`, agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: tmpdir(), branch: `cw/s${i}`, createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null, enforcementTier: 'T3', pid: null, launchArgs: null,
      });
    }

    const methods = buildMethods(db, fixture.root);
    const result = (await methods['converge.status']!(
      { workspaceId: 'ws_1' },
      { notify: () => undefined, onClose: () => undefined },
    )) as { degraded: boolean };

    expect(result.degraded).toBe(true);
    await fixture.cleanup();
  });

  // Important 1: `recommendedOrder` is an ordering of every ACTIVE session,
  // conflicts and all — it is not a filter. `cw land all` needs the actual
  // conflict-free subset so it lands what it safely can instead of halting the
  // whole batch on a session that was never going to land cleanly.
  test('conflictFree excludes every session with a known conflict, unlike recommendedOrder', async () => {
    const fixture = await makeGitFixture();
    const db = openDatabase(':memory:');
    const projectRoot = fixture.root;
    const baseHead = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: projectRoot, encoding: 'utf8',
    }).trim();
    new WorkspaceRepo(db).insert({
      id: 'ws_1', name: 'w', rootPath: projectRoot, createdAt: 'now',
      defaultIsolation: 'worktree', safeModeTier: 'T1',
    });
    const sessions = new SessionRepo(db);
    // A and B conflict with EACH OTHER (both would merge cleanly against base
    // individually — the conflict is pairwise, not "against base"). C conflicts
    // with nothing.
    for (const [id, branch, createdAt] of [
      ['s_a', 'cw/a', '2026-01-01T00:00:01.000Z'],
      ['s_b', 'cw/b', '2026-01-01T00:00:02.000Z'],
      ['s_c', 'cw/c', '2026-01-01T00:00:03.000Z'],
    ] as const) {
      sessions.insert({
        id, workspaceId: 'ws_1', name: id.slice(2), agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: tmpdir(), branch, createdAt,
        lastActiveAt: createdAt, tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null, enforcementTier: 'T3', pid: null, launchArgs: null,
      });
    }
    new MergeTrialRepo(db).insert({
      id: 'mt_1', workspaceId: 'ws_1', ts: 'now', branches: ['cw/a', 'cw/b'],
      result: 'conflict', detail: 'x.ts', baseHead, pairwise: true,
    });
    new MergeTrialRepo(db).insert({
      id: 'mt_2', workspaceId: 'ws_1', ts: 'now', branches: ['cw/a', 'cw/c'],
      result: 'clean', detail: null, baseHead, pairwise: true,
    });
    new MergeTrialRepo(db).insert({
      id: 'mt_3', workspaceId: 'ws_1', ts: 'now', branches: ['cw/b', 'cw/c'],
      result: 'clean', detail: null, baseHead, pairwise: true,
    });
    new MergeTrialRepo(db).insert({
      id: 'mt_4', workspaceId: 'ws_1', ts: 'now', branches: ['cw/a', 'cw/b', 'cw/c'],
      result: 'clean', detail: null, baseHead, pairwise: false,
    });

    const methods = buildMethods(db, projectRoot);
    const result = (await methods['converge.status']!(
      { workspaceId: 'ws_1' },
      { notify: () => undefined, onClose: () => undefined },
    )) as {
      recommendedOrder: string[];
      conflictFree: string[];
      fullIntegration: { baseHead: string } | null;
    };

    expect(result.recommendedOrder).toContain('a');
    expect(result.recommendedOrder).toContain('b');
    expect(result.recommendedOrder).toContain('c');
    expect(result.conflictFree).toEqual(['c']);
    expect(result.conflictFree).not.toContain('a');
    expect(result.conflictFree).not.toContain('b');
    expect(result.fullIntegration?.baseHead).toBe(baseHead);
    await fixture.cleanup();
  });
});

async function branchWithFile(root: string, branch: string, file: string, content: string): Promise<void> {
  await $`git checkout -q -b ${branch}`.cwd(root).quiet();
  await commitFile(root, file, content, `add ${file}`);
  await $`git checkout -q main`.cwd(root).quiet();
}

describe('converge.status: trial kind is read from the recorded kind, not the branch count', () => {
  const ctx = { notify: () => undefined, onClose: () => undefined };

  // C1: with exactly 2 active sessions a full-integration trial has
  // branches.length === 2 — the same shape a genuine pairwise trial has. Reading
  // "full integration" as `branches.length > 2` therefore found nothing at all,
  // AND let the full-integration row win the latest-by-pair lookup that decides
  // landability, so one `unverified` full-integration tick left both sessions
  // permanently unknown with nothing landable. The rows here come from a real
  // scheduler tick, which is the only thing that knows which kind it recorded.
  test('a 2-branch full-integration trial neither hides itself nor poisons the pair\'s latest pairwise evidence', async () => {
    const fixture = await makeGitFixture();
    try {
      await branchWithFile(fixture.root, 'cw/a', 'a.txt', 'a\n');
      await branchWithFile(fixture.root, 'cw/b', 'b.txt', 'b\n');

      const db = openDatabase(':memory:');
      new WorkspaceRepo(db).insert({
        id: 'ws_1', name: 'w', rootPath: fixture.root, createdAt: 'now',
        defaultIsolation: 'worktree', safeModeTier: 'T1',
      });
      const sessions = new SessionRepo(db);
      for (const [id, name] of [['s_a', 'a'], ['s_b', 'b']] as const) {
        sessions.insert({
          id, workspaceId: 'ws_1', name, agentKind: 'claude', adapter: 'claude',
          status: 'running', worktreePath: fixture.root, branch: `cw/${name}`, createdAt: `now-${name}`,
          lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null, enforcementTier: 'T3', pid: null, launchArgs: null,
        });
      }
      // fullIntegrationIntervalMs: 0 makes the full-integration run happen on the
      // same tick as the pairwise sweep; no testCommand makes it record
      // 'unverified', genuinely differing from the pairwise 'clean' for the pair.
      const config = {
        ...DEFAULT_CONFIG,
        converge: { ...DEFAULT_CONFIG.converge, trialDebounceMs: 0, fullIntegrationIntervalMs: 0 },
      };
      const scheduler = new ConvergenceScheduler(
        db, fixture.root, config, new LeaseManager(db, fixture.root, config), new ConfigTrustRepo(db),
      );
      await scheduler.tick();

      const trials = new MergeTrialRepo(db).listByWorkspace('ws_1');
      expect(trials).toHaveLength(2); // both rows carry exactly 2 branches
      expect(trials.every((t) => t.branches.length === 2)).toBe(true);

      const methods = buildMethods(db, fixture.root, undefined, config, { notifySend: () => {} });
      const result = (await methods['converge.status']!({ workspaceId: 'ws_1' }, ctx)) as {
        pairwise: { a: string; b: string; result: string }[];
        fullIntegration: { result: string } | null;
        ready: string[];
        unknown: { name: string; reason: string }[];
      };

      expect(result.pairwise).toEqual([{ a: 'cw/a', b: 'cw/b', result: 'clean' }]);
      expect(result.fullIntegration?.result).toBe('unverified');
      expect(result.unknown).toEqual([]);
      expect(result.ready).toEqual(['a', 'b']);
    } finally {
      await fixture.cleanup();
    }
  });

  // I3: reading the base HEAD is a read of the user's repository and can fail for
  // ordinary reasons — an unborn branch here, a git binary problem elsewhere. It
  // used to be an unguarded execFileSync, so a plain status query crashed the RPC
  // with INTERNAL. Now every session reports `unknown`, and notably NOT `blocked`:
  // without the base HEAD, no recorded conflict can be shown to still apply.
  test('an unreadable base HEAD degrades every session to unknown instead of failing the query', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cw-unborn-'));
    try {
      await $`git init -q -b main`.cwd(root).quiet(); // no commits at all: HEAD is unborn
      const db = openDatabase(':memory:');
      new WorkspaceRepo(db).insert({
        id: 'ws_1', name: 'w', rootPath: root, createdAt: 'now',
        defaultIsolation: 'worktree', safeModeTier: 'T1',
      });
      const sessions = new SessionRepo(db);
      for (const [id, name] of [['s_a', 'a'], ['s_b', 'b']] as const) {
        sessions.insert({
          id, workspaceId: 'ws_1', name, agentKind: 'claude', adapter: 'claude',
          status: 'running', worktreePath: root, branch: `cw/${name}`, createdAt: `now-${name}`,
          lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null, enforcementTier: 'T3', pid: null, launchArgs: null,
        });
      }
      new MergeTrialRepo(db).insert({
        id: 'mt_1', workspaceId: 'ws_1', ts: 'now', branches: ['cw/a', 'cw/b'],
        result: 'conflict', detail: 'x.ts', baseHead: 'base-abc', pairwise: true,
      });

      const methods = buildMethods(db, root, undefined, undefined, { notifySend: () => {} });
      const result = (await methods['converge.status']!({ workspaceId: 'ws_1' }, ctx)) as {
        ready: string[];
        blocked: { name: string }[];
        unknown: { name: string; reason: string }[];
      };

      expect(result.ready).toEqual([]);
      expect(result.blocked).toEqual([]);
      expect(result.unknown).toEqual([
        { name: 'a', reason: 'the base branch HEAD could not be read' },
        { name: 'b', reason: 'the base branch HEAD could not be read' },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
