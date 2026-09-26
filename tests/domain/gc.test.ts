import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, utimesSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceManager } from '../../src/domain/workspace.js';
import { SessionManager } from '../../src/domain/session.js';
import { collectGarbage, collectOrphans } from '../../src/domain/gc.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { LeaseRepo } from '../../src/db/repositories/lease.js';
import { LeaseManager } from '../../src/isolation/leases/manager.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { makeGitFixture, type GitFixture } from '../helpers/git-fixture.js';

let fx: GitFixture;
let db: Database;
let sessions: SessionManager;
let workspaceId: string;

beforeEach(async () => {
  fx = await makeGitFixture();
  db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
  workspaceId = new WorkspaceManager(db).init(fx.root).id;
  sessions = new SessionManager(db);
});

afterEach(async () => {
  db.close();
  await fx.cleanup();
});

describe('collectGarbage', () => {
  it('reclaims dead sessions and leaves live ones alone', async () => {
    const dead = await sessions.create({ workspaceId, name: 'dead', worktree: true });
    const live = await sessions.create({ workspaceId, name: 'live', worktree: true });
    await sessions.kill(workspaceId, 'dead', { removeWorktree: false });

    const result = await collectGarbage(db, workspaceId);

    expect(result.removed).toEqual(['dead']);
    expect(result.reclaimedBytes).toBeGreaterThan(0);
    expect(existsSync(dead.worktreePath ?? '')).toBe(false);
    expect(existsSync(live.worktreePath ?? '')).toBe(true);
    expect(sessions.list(workspaceId).map((s) => s.name)).toEqual(['live']);
  }, 30_000);

  // `kill` leaves a dead session's worktree and branch on disk precisely so it can
  // still be landed; gc used to delete them regardless, work and all.
  describe('a dead session that still holds unlanded work', () => {
    async function deadWithCommit(name: string) {
      const row = await sessions.create({ workspaceId, name, worktree: true });
      const { simpleGit } = await import('simple-git');
      await writeFile(join(row.worktreePath ?? '', 'feature.txt'), 'work\n');
      await simpleGit(row.worktreePath ?? '').add('feature.txt').commit('feature');
      await sessions.kill(workspaceId, name, { removeWorktree: false });
      return row;
    }

    it('is kept, and reported as kept, when its branch has commits no other branch holds', async () => {
      const row = await deadWithCommit('unlanded');
      const result = await collectGarbage(db, workspaceId);
      expect(result.removed).toEqual([]);
      expect(result.kept).toEqual(['unlanded']);
      expect(existsSync(row.worktreePath ?? '')).toBe(true);
      const { simpleGit } = await import('simple-git');
      expect((await simpleGit(fx.root).branch()).all).toContain('cw/unlanded');
    }, 30_000);

    it('is kept when its worktree has uncommitted changes', async () => {
      const row = await sessions.create({ workspaceId, name: 'dirty', worktree: true });
      await writeFile(join(row.worktreePath ?? '', 'scratch.txt'), 'not committed\n');
      await sessions.kill(workspaceId, 'dirty', { removeWorktree: false });
      const result = await collectGarbage(db, workspaceId);
      expect(result.kept).toEqual(['dirty']);
      expect(existsSync(join(row.worktreePath ?? '', 'scratch.txt'))).toBe(true);
    }, 30_000);

    it('is reclaimed once another branch holds its commits', async () => {
      await deadWithCommit('merged');
      const { simpleGit } = await import('simple-git');
      await simpleGit(fx.root).raw(['branch', 'keep-copy', 'cw/merged']);
      const result = await collectGarbage(db, workspaceId);
      expect(result.removed).toEqual(['merged']);
      expect(result.kept).toEqual([]);
    }, 30_000);

    it('is reclaimed with force', async () => {
      const row = await deadWithCommit('forced');
      const result = await collectGarbage(db, workspaceId, { force: true });
      expect(result.removed).toEqual(['forced']);
      expect(existsSync(row.worktreePath ?? '')).toBe(false);
    }, 30_000);
  });

  it('is a no-op when nothing has ended', async () => {
    await sessions.create({ workspaceId, name: 'live', worktree: true });
    const result = await collectGarbage(db, workspaceId);
    expect(result.removed).toEqual([]);
    expect(result.reclaimedBytes).toBe(0);
  }, 30_000);

  it('deletes the dead session\'s branch too, freeing the name', async () => {
    await sessions.create({ workspaceId, name: 'recycle', worktree: true });
    await sessions.kill(workspaceId, 'recycle', { removeWorktree: false });
    await collectGarbage(db, workspaceId);

    const { simpleGit } = await import('simple-git');
    expect((await simpleGit(fx.root).branch()).all).not.toContain('cw/recycle');
    const revived = await sessions.create({ workspaceId, name: 'recycle', worktree: true });
    expect(revived.branch).toBe('cw/recycle');
  }, 30_000);

  it('reclaims worktrees no session row claims', async () => {
    await sessions.create({ workspaceId, name: 'orphan', worktree: true });
    // Simulate what `workspace delete --force` leaves: the row is gone, the disk is not.
    const row = sessions.resolve(workspaceId, 'orphan');
    new SessionRepo(db).delete(row.id);
    expect(existsSync(row.worktreePath ?? '')).toBe(true);

    // Age it past the orphan-sweep grace window — a directory this fresh is
    // indistinguishable from one whose `create()` call just hasn't inserted its row
    // yet, and the sweep must not touch it. See the next test for that case.
    const old = new Date(Date.now() - 10_000);
    utimesSync(row.worktreePath ?? '', old, old);

    const result = await collectGarbage(db, workspaceId);
    expect(result.removed).toHaveLength(1);
    expect(existsSync(row.worktreePath ?? '')).toBe(false);
  }, 30_000);

  // Nothing else deletes these, and `measureWorktrees` cannot see them, so before this
  // a session's cache and copied database survived every reclaim and grew invisibly
  // against the disk budget.
  it('deletes the ended session\'s leased cache directory and copied database', async () => {
    await writeFile(join(fx.root, 'app.db'), 'sqlite');
    const session = await sessions.create({
      workspaceId, name: 'leased', worktree: true,
    });
    const config = { ...DEFAULT_CONFIG, db: { strategy: 'file-copy' as const, url: 'app.db' } };
    const env = await new LeaseManager(db, fx.root, config).acquire(session.id);
    const cache = env.XDG_CACHE_HOME ?? '';
    const copied = env.DATABASE_URL ?? '';
    expect(existsSync(cache)).toBe(true);
    expect(existsSync(copied)).toBe(true);

    await sessions.kill(workspaceId, 'leased', { removeWorktree: false });
    await collectGarbage(db, workspaceId);

    expect(existsSync(cache)).toBe(false);
    expect(existsSync(copied)).toBe(false);
  }, 30_000);

  // The `schema` strategy's db lease holds a Postgres schema name, not a path.
  it('does not treat a schema-strategy db lease as a filesystem path', async () => {
    const session = await sessions.create({
      workspaceId, name: 'schema', worktree: true,
    });
    const config = {
      ...DEFAULT_CONFIG,
      db: { strategy: 'schema' as const, url: 'postgres://localhost/app' },
    };
    await new LeaseManager(db, fx.root, config).acquire(session.id);
    expect(new LeaseRepo(db).listBySession(session.id).map((l) => l.value))
      .toContain(`cw_${session.id}`);

    await sessions.kill(workspaceId, 'schema', { removeWorktree: false });
    const result = await collectGarbage(db, workspaceId);
    expect(result.removed).toContain('schema');
  }, 30_000);

  it('does not reclaim a worktree that is still mid-creation', async () => {
    await sessions.create({ workspaceId, name: 'brand-new', worktree: true });
    // Same shape as a genuine orphan — the row is gone, the disk is not — but the
    // directory's mtime is fresh, as it would be for a `create()` call caught between
    // `createWorktree` returning and `sessions.insert` committing.
    const row = sessions.resolve(workspaceId, 'brand-new');
    new SessionRepo(db).delete(row.id);

    const result = await collectGarbage(db, workspaceId);
    expect(result.removed).toEqual([]);
    expect(existsSync(row.worktreePath ?? '')).toBe(true);
  }, 30_000);
});

/**
 * Boot-time gc is the ONLY caller that must not reclaim ended sessions. `cw session
 * kill` without `--rm-worktree` deliberately leaves the session `dead` with its
 * worktree and branch intact — M4's `cw land` needs the branch — so a daemon restart
 * running the full sweep would silently destroy work nobody asked it to touch.
 */
describe('collectOrphans', () => {
  it('leaves a killed session\'s worktree and branch alone', async () => {
    const killed = await sessions.create({
      workspaceId, name: 'keepme', worktree: true,
    });
    await sessions.kill(workspaceId, 'keepme', { removeWorktree: false });

    // Age it past the grace window so nothing but the ended-session filter can be
    // what saves it.
    const old = new Date(Date.now() - 10_000);
    utimesSync(killed.worktreePath ?? '', old, old);

    const result = await collectOrphans(db, workspaceId);

    expect(result.removed).toEqual([]);
    expect(existsSync(killed.worktreePath ?? '')).toBe(true);
    const { simpleGit } = await import('simple-git');
    expect((await simpleGit(fx.root).branch()).all).toContain('cw/keepme');
    expect(sessions.resolve(workspaceId, 'keepme').status).toBe('dead');
  }, 30_000);

  it('still reclaims a worktree no session row claims', async () => {
    await sessions.create({ workspaceId, name: 'orphan', worktree: true });
    const row = sessions.resolve(workspaceId, 'orphan');
    new SessionRepo(db).delete(row.id);
    const old = new Date(Date.now() - 10_000);
    utimesSync(row.worktreePath ?? '', old, old);

    const result = await collectOrphans(db, workspaceId);
    expect(result.removed).toHaveLength(1);
    expect(existsSync(row.worktreePath ?? '')).toBe(false);
  }, 30_000);

  // crossweave creates worktrees in exactly two places, both under `.crossweave/`
  // (a session's at `.crossweave/worktrees/<id>`, the integration scratch at
  // `.crossweave/integration`). A worktree anywhere else — `.worktrees/`, a second
  // checkout for a long-running branch — is the user's, and no session row claims
  // it either way, so "unclaimed" alone cannot make it ours. Before this guard the
  // sweep reclaimed every unclaimed worktree `git worktree list` reported, which
  // meant the boot sweep destroyed the developer's own in-progress worktrees,
  // uncommitted work included, on the first `cw` command run from the repo root.
  it('never reclaims a worktree crossweave did not create', async () => {
    const { simpleGit } = await import('simple-git');
    const devPath = join(fx.root, '.worktrees', 'mine');
    await simpleGit(fx.root).raw(['worktree', 'add', '-b', 'feat/mine', devPath]);
    await writeFile(join(devPath, 'work.txt'), 'uncommitted work\n');

    // Aged past the grace window so nothing but the ownership check can save it.
    const old = new Date(Date.now() - 10_000);
    utimesSync(devPath, old, old);

    const result = await collectOrphans(db, workspaceId);

    expect(result.removed).toEqual([]);
    expect(existsSync(join(devPath, 'work.txt'))).toBe(true);
  }, 30_000);
});

describe('boot-time gc', () => {
  it('does not destroy a killed session\'s worktree or branch on daemon restart', async () => {
    const killed = await sessions.create({
      workspaceId, name: 'survivor', worktree: true,
    });
    await sessions.kill(workspaceId, 'survivor', { removeWorktree: false });
    const old = new Date(Date.now() - 10_000);
    utimesSync(killed.worktreePath ?? '', old, old);

    // What a daemon restart does against the same state: a fresh buildMethods over
    // the same database. Its boot sweep is fire-and-forget, so give it room to run.
    buildMethods(db, fx.root);
    await new Promise((r) => setTimeout(r, 1000));

    expect(existsSync(killed.worktreePath ?? '')).toBe(true);
    const { simpleGit } = await import('simple-git');
    expect((await simpleGit(fx.root).branch()).all).toContain('cw/survivor');
    expect(sessions.list(workspaceId).map((s) => s.name)).toEqual(['survivor']);
  }, 30_000);

  it('still sweeps a genuine orphan on daemon restart', async () => {
    await sessions.create({ workspaceId, name: 'stray', worktree: true });
    const row = sessions.resolve(workspaceId, 'stray');
    new SessionRepo(db).delete(row.id);
    const old = new Date(Date.now() - 10_000);
    utimesSync(row.worktreePath ?? '', old, old);

    buildMethods(db, fx.root);
    await new Promise((r) => setTimeout(r, 1000));

    expect(existsSync(row.worktreePath ?? '')).toBe(false);
  }, 30_000);

  it('does not destroy the developer\'s own worktree on daemon restart', async () => {
    const { simpleGit } = await import('simple-git');
    const devPath = join(fx.root, '.worktrees', 'mine');
    await simpleGit(fx.root).raw(['worktree', 'add', '-b', 'feat/mine', devPath]);
    await writeFile(join(devPath, 'work.txt'), 'uncommitted work\n');
    const old = new Date(Date.now() - 10_000);
    utimesSync(devPath, old, old);

    buildMethods(db, fx.root);
    await new Promise((r) => setTimeout(r, 1000));

    expect(existsSync(join(devPath, 'work.txt'))).toBe(true);
  }, 30_000);
});
