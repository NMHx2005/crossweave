import { describe, expect, test } from 'bun:test';
import { $ } from 'bun';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo, type SessionRow } from '../../src/db/repositories/session.js';
import { EventRepo } from '../../src/db/repositories/event.js';
import { LeaseManager } from '../../src/isolation/leases/manager.js';
import { EventLedger } from '../../src/domain/ledger.js';
import { DEFAULT_CONFIG, type CrossweaveConfig } from '../../src/core/config.js';
import { landSession, type LandResult } from '../../src/convergence/land.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { ClaudePtyAdapter } from '../../src/adapters/claude-pty.js';
import type { AgentAdapter } from '../../src/adapters/types.js';
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

function insertSession(sessions: SessionRepo, overrides: Partial<SessionRow> & { id: string; branch: string | null }): void {
  sessions.insert({
    id: overrides.id,
    workspaceId: 'ws_1',
    name: overrides.name ?? overrides.id,
    agentKind: 'claude',
    adapter: 'claude',
    status: overrides.status ?? 'idle',
    worktreePath: overrides.worktreePath ?? null,
    branch: overrides.branch,
    createdAt: 'now',
    lastActiveAt: 'now',
    tokenBudget: null,
    tokenSpent: 0,
    enforcementTier: 'T3',
    pid: null,
  });
}

function withStrategy(strategy: CrossweaveConfig['converge']['mergeStrategy']): CrossweaveConfig {
  return { ...DEFAULT_CONFIG, converge: { ...DEFAULT_CONFIG.converge, mergeStrategy: strategy } };
}

function withTestCommand(cmd: string): CrossweaveConfig {
  return { ...DEFAULT_CONFIG, converge: { ...DEFAULT_CONFIG.converge, testCommand: cmd } };
}

describe('landSession', () => {
  test('refuses a running session unless force', async () => {
    const fixture = await makeGitFixture();
    try {
      await $`git checkout -q -b cw/a`.cwd(fixture.root).quiet();
      await commitFile(fixture.root, 'a.txt', 'a\n', 'add a');
      await $`git checkout -q main`.cwd(fixture.root).quiet();
      const { db, sessions, leaseManager, ledger, config } = await setup(fixture);
      insertSession(sessions, { id: 's_a', worktreePath: fixture.root, branch: 'cw/a', status: 'running' });

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
      insertSession(sessions, { id: 's_a', worktreePath: fixture.root, branch: 'cw/a' });

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
      insertSession(sessions, { id: 's_a', worktreePath: fixture.root, branch: 'cw/a' });

      const result = await landSession(
        { db, projectRoot: fixture.root, sessions, leaseManager, ledger, config }, 'ws_1', 's_a', { force: false },
      );
      expect(result.status).toBe('landed');
      expect(result.baseBranch).toBe('main');
      expect(result.warnings).toEqual([]);

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
      insertSession(sessions, { id: 's_a', worktreePath: fixture.root, branch: 'cw/a' });

      const result = await landSession(
        { db, projectRoot: fixture.root, sessions, leaseManager, ledger, config }, 'ws_1', 's_a', { force: false },
      );
      expect(result.tested).toBe('unverified');
    } finally {
      await fixture.cleanup();
    }
  });

  test('LAND_NO_BRANCH: refuses a session with no branch (started with --no-worktree)', async () => {
    const fixture = await makeGitFixture();
    try {
      const { db, sessions, leaseManager, ledger, config } = await setup(fixture);
      insertSession(sessions, { id: 's_a', worktreePath: fixture.root, branch: null });

      await expect(
        landSession({ db, projectRoot: fixture.root, sessions, leaseManager, ledger, config }, 'ws_1', 's_a', { force: false }),
      ).rejects.toMatchObject({ code: 'LAND_NO_BRANCH' });
    } finally {
      await fixture.cleanup();
    }
  });

  test('LAND_DIRTY_TREE: refuses when the main checkout has uncommitted changes, before any mutation', async () => {
    const fixture = await makeGitFixture();
    try {
      await $`git checkout -q -b cw/a`.cwd(fixture.root).quiet();
      await commitFile(fixture.root, 'a.txt', 'a\n', 'add a');
      await $`git checkout -q main`.cwd(fixture.root).quiet();
      await writeFile(join(fixture.root, 'wip.txt'), 'someone else\'s unrelated work\n');
      await $`git add wip.txt`.cwd(fixture.root).quiet();

      const { db, sessions, leaseManager, ledger, config } = await setup(fixture);
      insertSession(sessions, { id: 's_a', worktreePath: fixture.root, branch: 'cw/a' });

      await expect(
        landSession({ db, projectRoot: fixture.root, sessions, leaseManager, ledger, config }, 'ws_1', 's_a', { force: false }),
      ).rejects.toMatchObject({ code: 'LAND_DIRTY_TREE' });

      // The dirty file must survive untouched — never swept into a land commit.
      const status = execFileSync('git', ['status', '--porcelain'], { cwd: fixture.root, encoding: 'utf8' });
      expect(status).toContain('wip.txt');
      const mainLog = execFileSync('git', ['log', '--oneline', '-1', 'main'], { cwd: fixture.root, encoding: 'utf8' });
      expect(mainLog).not.toContain('squashed');
    } finally {
      await fixture.cleanup();
    }
  });

  test('refuses on a detached HEAD main checkout, before any mutation', async () => {
    const fixture = await makeGitFixture();
    try {
      await $`git checkout -q -b cw/a`.cwd(fixture.root).quiet();
      await commitFile(fixture.root, 'a.txt', 'a\n', 'add a');
      await $`git checkout -q main`.cwd(fixture.root).quiet();
      const head = (await $`git rev-parse HEAD`.cwd(fixture.root).quiet().text()).trim();
      await $`git checkout -q ${head}`.cwd(fixture.root).quiet();

      const { db, sessions, leaseManager, ledger, config } = await setup(fixture);
      insertSession(sessions, { id: 's_a', worktreePath: fixture.root, branch: 'cw/a' });

      await expect(
        landSession({ db, projectRoot: fixture.root, sessions, leaseManager, ledger, config }, 'ws_1', 's_a', { force: false }),
      ).rejects.toMatchObject({ code: 'LAND_NO_BASE_BRANCH' });
    } finally {
      await fixture.cleanup();
    }
  });

  test('plain merge strategy: creates a real merge commit with two parents', async () => {
    const fixture = await makeGitFixture();
    try {
      await $`git checkout -q -b cw/a`.cwd(fixture.root).quiet();
      await commitFile(fixture.root, 'a.txt', 'a\n', 'add a');
      await $`git checkout -q main`.cwd(fixture.root).quiet();

      const config = withStrategy('merge');
      const { db, sessions, leaseManager, ledger } = await setup(fixture, config);
      insertSession(sessions, { id: 's_a', worktreePath: fixture.root, branch: 'cw/a' });

      const result = await landSession(
        { db, projectRoot: fixture.root, sessions, leaseManager, ledger, config }, 'ws_1', 's_a', { force: false },
      );
      expect(result.status).toBe('landed');

      const parents = execFileSync('git', ['log', '--pretty=%P', '-1', 'main'], { cwd: fixture.root, encoding: 'utf8' }).trim().split(' ');
      expect(parents).toHaveLength(2);
      const mainFiles = execFileSync('git', ['ls-tree', '-r', '--name-only', 'main'], { cwd: fixture.root, encoding: 'utf8' });
      expect(mainFiles).toContain('a.txt');
    } finally {
      await fixture.cleanup();
    }
  });

  test('rebase strategy: fast-forwards a rewritten branch onto base, leaving a linear history', async () => {
    const fixture = await makeGitFixture();
    try {
      await $`git checkout -q -b cw/a`.cwd(fixture.root).quiet();
      await commitFile(fixture.root, 'a.txt', 'a\n', 'add a');
      await $`git checkout -q main`.cwd(fixture.root).quiet();
      // Advances base independently of the branch's own file, so the rebase
      // genuinely replays `cw/a`'s commit onto a different tip instead of being a
      // no-op — and non-conflicting, so this exercises the success path.
      await commitFile(fixture.root, 'other.txt', 'x\n', 'main advances independently');

      const config = withStrategy('rebase');
      const { db, sessions, leaseManager, ledger } = await setup(fixture, config);
      insertSession(sessions, { id: 's_a', worktreePath: fixture.root, branch: 'cw/a' });

      const result = await landSession(
        { db, projectRoot: fixture.root, sessions, leaseManager, ledger, config }, 'ws_1', 's_a', { force: false },
      );
      expect(result.status).toBe('landed');

      const parents = execFileSync('git', ['log', '--pretty=%P', '-1', 'main'], { cwd: fixture.root, encoding: 'utf8' }).trim().split(' ');
      expect(parents).toHaveLength(1); // fast-forward, not a merge commit
      const mainFiles = execFileSync('git', ['ls-tree', '-r', '--name-only', 'main'], { cwd: fixture.root, encoding: 'utf8' });
      expect(mainFiles).toContain('a.txt');
      expect(mainFiles).toContain('other.txt');
    } finally {
      await fixture.cleanup();
    }
  });

  test('rebase strategy: an ordinary clean trial on the SAME file (different regions) does not collide with leftover trial state', async () => {
    // Regression test for a bug the resetIntegration-into-finally restructure
    // introduced: `runMergeTrial`'s `--no-commit` merge leaves the integration
    // worktree with staged/uncommitted changes. Without an explicit reset BEFORE
    // the strategy block reuses that worktree, `rebase`'s `checkout -B cw/trial
    // <branch>` collides with those leftovers — even on a completely ordinary,
    // non-conflicting rebase where base and the branch touch the same file in
    // different, unrelated regions (line 1 vs. the last line), which is exactly
    // the shape the two existing rebase tests both happened to avoid.
    const fixture = await makeGitFixture();
    try {
      const lines = ['line1', 'line2', 'line3', 'line4', 'line5'];
      await commitFile(fixture.root, 'multi.txt', `${lines.join('\n')}\n`, 'seed multi-line file');
      await $`git checkout -q -b cw/a`.cwd(fixture.root).quiet();
      await commitFile(fixture.root, 'multi.txt', `${['line1-a', ...lines.slice(1)].join('\n')}\n`, 'a: edit line 1');
      await $`git checkout -q main`.cwd(fixture.root).quiet();
      await commitFile(fixture.root, 'multi.txt', `${[...lines.slice(0, 4), 'line5-main'].join('\n')}\n`, 'main: edit line 5');

      const config = withStrategy('rebase');
      const { db, sessions, leaseManager, ledger } = await setup(fixture, config);
      insertSession(sessions, { id: 's_a', worktreePath: fixture.root, branch: 'cw/a' });

      const result = await landSession(
        { db, projectRoot: fixture.root, sessions, leaseManager, ledger, config }, 'ws_1', 's_a', { force: false },
      );
      expect(result.status).toBe('landed');

      const mainFile = execFileSync('git', ['show', 'main:multi.txt'], { cwd: fixture.root, encoding: 'utf8' });
      expect(mainFile).toContain('line1-a');
      expect(mainFile).toContain('line5-main');
    } finally {
      await fixture.cleanup();
    }
  });

  test('LAND_REBASE_CONFLICT: a rebase can fail even after a clean trial merge, and the main checkout stays untouched', async () => {
    const fixture = await makeGitFixture();
    try {
      // Classic "clean 3-way merge, conflicting rebase replay" repro: the branch's
      // two commits net out to a no-op on shared.txt (temp, then back to orig), so
      // the trial's 3-way diff sees no branch-side change to reconcile against
      // base's edit — clean. But rebase replays each commit as its OWN patch: the
      // first commit's patch (orig -> temp) does not apply against base's content
      // (main-edit), which conflicts even though the branch's net effect wouldn't.
      await commitFile(fixture.root, 'shared.txt', 'orig\n', 'seed');
      await $`git checkout -q -b cw/a`.cwd(fixture.root).quiet();
      await commitFile(fixture.root, 'shared.txt', 'temp\n', 'a: temp change');
      await commitFile(fixture.root, 'shared.txt', 'orig\n', 'a: revert to orig');
      await $`git checkout -q main`.cwd(fixture.root).quiet();
      await commitFile(fixture.root, 'shared.txt', 'main-edit\n', 'main edits shared');

      const config = withStrategy('rebase');
      const { db, sessions, leaseManager, ledger } = await setup(fixture, config);
      insertSession(sessions, { id: 's_a', worktreePath: fixture.root, branch: 'cw/a' });

      await expect(
        landSession({ db, projectRoot: fixture.root, sessions, leaseManager, ledger, config }, 'ws_1', 's_a', { force: false }),
      ).rejects.toMatchObject({ code: 'LAND_REBASE_CONFLICT' });

      // The rebase happens ONLY in the scratch integration worktree — the main
      // checkout must never see a conflict, a rebase-in-progress state, or any
      // change to its own content.
      const mainFile = execFileSync('git', ['show', 'main:shared.txt'], { cwd: fixture.root, encoding: 'utf8' });
      expect(mainFile).toBe('main-edit\n');
      // `.crossweave/` (the scratch integration worktree `ensureIntegrationWorktree`
      // just created) is expected here — it's this tool's own infrastructure, not
      // conflict fallout. Nothing else should be dirty.
      const status = execFileSync('git', ['status', '--porcelain'], { cwd: fixture.root, encoding: 'utf8' });
      const dirtyOutsideScratch = status.split('\n').filter((l) => l.length > 0 && !l.includes('.crossweave'));
      expect(dirtyOutsideScratch).toEqual([]);

      // The scratch worktree must have self-healed too — a fresh, unrelated land
      // (retried here against a config that no longer conflicts) must not still be
      // stuck mid-rebase from the failed attempt above.
      const squashConfig = withStrategy('squash');
      await commitFile(fixture.root, 'unrelated.txt', 'z\n', 'unrelated main progress');
      await $`git checkout -q -b cw/c`.cwd(fixture.root).quiet();
      await commitFile(fixture.root, 'c.txt', 'c\n', 'add c');
      await $`git checkout -q main`.cwd(fixture.root).quiet();
      insertSession(sessions, { id: 's_c', worktreePath: fixture.root, branch: 'cw/c' });
      const retry = await landSession(
        { db, projectRoot: fixture.root, sessions, leaseManager, ledger, config: squashConfig }, 'ws_1', 's_c', { force: false },
      );
      expect(retry.status).toBe('landed');
    } finally {
      await fixture.cleanup();
    }
  });

  test('testCommand configured and passing: reports tested clean', async () => {
    const fixture = await makeGitFixture();
    try {
      await $`git checkout -q -b cw/a`.cwd(fixture.root).quiet();
      await commitFile(fixture.root, 'a.txt', 'a\n', 'add a');
      await $`git checkout -q main`.cwd(fixture.root).quiet();

      const config = withTestCommand('exit 0');
      const { db, sessions, leaseManager, ledger } = await setup(fixture, config);
      insertSession(sessions, { id: 's_a', worktreePath: fixture.root, branch: 'cw/a' });

      const result = await landSession(
        { db, projectRoot: fixture.root, sessions, leaseManager, ledger, config }, 'ws_1', 's_a', { force: false },
      );
      expect(result.tested).toBe('clean');
      expect(result.status).toBe('landed');
    } finally {
      await fixture.cleanup();
    }
  });

  test('LAND_TEST_FAILED: testCommand configured and failing refuses to land, main checkout untouched', async () => {
    const fixture = await makeGitFixture();
    try {
      await $`git checkout -q -b cw/a`.cwd(fixture.root).quiet();
      await commitFile(fixture.root, 'a.txt', 'a\n', 'add a');
      await $`git checkout -q main`.cwd(fixture.root).quiet();
      const beforeHead = (await $`git rev-parse HEAD`.cwd(fixture.root).quiet().text()).trim();

      const config = withTestCommand('exit 1');
      const { db, sessions, leaseManager, ledger } = await setup(fixture, config);
      insertSession(sessions, { id: 's_a', worktreePath: fixture.root, branch: 'cw/a' });

      await expect(
        landSession({ db, projectRoot: fixture.root, sessions, leaseManager, ledger, config }, 'ws_1', 's_a', { force: false }),
      ).rejects.toMatchObject({ code: 'LAND_TEST_FAILED' });

      const afterHead = execFileSync('git', ['rev-parse', 'main'], { cwd: fixture.root, encoding: 'utf8' }).trim();
      expect(afterHead).toBe(beforeHead);
      expect(sessions.findById('s_a')?.status).not.toBe('landed');
    } finally {
      await fixture.cleanup();
    }
  });

  test('LAND_BASE_MOVED: refuses when the base branch moves while a slow test command is still running', async () => {
    const fixture = await makeGitFixture();
    try {
      await $`git checkout -q -b cw/a`.cwd(fixture.root).quiet();
      await commitFile(fixture.root, 'a.txt', 'a\n', 'add a');
      await $`git checkout -q main`.cwd(fixture.root).quiet();
      const beforeHead = (await $`git rev-parse HEAD`.cwd(fixture.root).quiet().text()).trim();

      // Simulates an external process (a user, or another tool) committing to the
      // base branch by hand while `cw land`'s test command is still running against
      // the trial's now-stale snapshot of it — the `landing` lock only rules out a
      // second CONCURRENT `cw land`, not this.
      const config = withTestCommand(`git -C ${fixture.root} commit --allow-empty -q -m moved-by-someone-else`);
      const { db, sessions, leaseManager, ledger } = await setup(fixture, config);
      insertSession(sessions, { id: 's_a', worktreePath: fixture.root, branch: 'cw/a' });

      await expect(
        landSession({ db, projectRoot: fixture.root, sessions, leaseManager, ledger, config }, 'ws_1', 's_a', { force: false }),
      ).rejects.toMatchObject({ code: 'LAND_BASE_MOVED' });

      // The external commit is left in place (land does not fight the user for
      // control of their own checkout) — it just must not be the base a squash/
      // merge/rebase silently lands on top of without re-validating.
      const afterHead = execFileSync('git', ['rev-parse', 'main'], { cwd: fixture.root, encoding: 'utf8' }).trim();
      expect(afterHead).not.toBe(beforeHead);
      expect(sessions.findById('s_a')?.status).not.toBe('landed');
    } finally {
      await fixture.cleanup();
    }
  });

  test('LAND_IN_PROGRESS: a second concurrent land for the same workspace is rejected while the first is still running', async () => {
    const fixture = await makeGitFixture();
    try {
      await $`git checkout -q -b cw/a`.cwd(fixture.root).quiet();
      await commitFile(fixture.root, 'a.txt', 'a\n', 'add a');
      await $`git checkout -q main`.cwd(fixture.root).quiet();
      await commitFile(fixture.root, 'b-seed.txt', 'seed\n', 'seed for b');
      await $`git checkout -q -b cw/b`.cwd(fixture.root).quiet();
      await commitFile(fixture.root, 'b.txt', 'b\n', 'add b');
      await $`git checkout -q main`.cwd(fixture.root).quiet();

      const { db, sessions, leaseManager, ledger, config } = await setup(fixture);
      insertSession(sessions, { id: 's_a', worktreePath: fixture.root, branch: 'cw/a' });
      insertSession(sessions, { id: 's_b', worktreePath: fixture.root, branch: 'cw/b' });

      const deps = { db, projectRoot: fixture.root, sessions, leaseManager, ledger, config };
      // Fired back-to-back, without awaiting the first: `landSession` does a
      // synchronous check-and-lock before its first `await`, so the second call
      // observes the lock the first one already took, even though neither has
      // resolved yet.
      const first = landSession(deps, 'ws_1', 's_a', { force: false });
      const second = landSession(deps, 'ws_1', 's_b', { force: false });

      await expect(second).rejects.toMatchObject({ code: 'LAND_IN_PROGRESS' });
      await expect(first).resolves.toMatchObject({ status: 'landed' });

      // The lock releases once the first land finishes — a later, non-concurrent
      // land for the same workspace must succeed normally.
      const retry = await landSession(deps, 'ws_1', 's_b', { force: false });
      expect(retry.status).toBe('landed');
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('land.session RPC', () => {
  function stubbornAdapterFactory(): AgentAdapter {
    // Ignores SIGTERM so a naive "release the lease and move on" force-land would
    // leave a live, orphaned process behind — proving `force` really stops it.
    return new ClaudePtyAdapter('sh', ['-c', 'sleep 999']);
  }

  test('force: true stops a running session\'s real agent process before landing it', async () => {
    const fixture = await makeGitFixture();
    try {
      const db = openDatabase(':memory:');
      new WorkspaceRepo(db).insert({
        id: 'ws_1', name: 'w', rootPath: fixture.root, createdAt: 'now',
        defaultIsolation: 'worktree', safeModeTier: 'T1',
      });
      const methods = buildMethods(db, fixture.root, stubbornAdapterFactory);
      const ctx = { notify: () => undefined, onClose: () => undefined };

      const created = (await methods['session.new']!(
        { workspaceId: 'ws_1', name: 'a', agent: 'claude', worktree: true }, ctx,
      )) as { worktreePath: string };
      // A branch identical to base has nothing for `--squash` to stage, and `git
      // commit` then fails on its own (a distinct, narrower edge case from the one
      // under test here) — give the session real work to land, matching every other
      // test in this file.
      await commitFile(created.worktreePath, 'agent-work.txt', 'work\n', 'agent commit');
      const started = (await methods['session.start']!({ workspaceId: 'ws_1', idOrName: 'a' }, ctx)) as { pid: number; status: string };
      expect(started.status).toBe('running');
      const pid = started.pid;

      const result = (await methods['land.session']!(
        { workspaceId: 'ws_1', idOrName: 'a', force: true }, ctx,
      )) as LandResult;
      expect(result.status).toBe('landed');

      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  }, 10_000);
});
