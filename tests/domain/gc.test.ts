import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceManager } from '../../src/domain/workspace.js';
import { SessionManager } from '../../src/domain/session.js';
import { collectGarbage } from '../../src/domain/gc.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
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
    const dead = await sessions.create({ workspaceId, name: 'dead', agent: 'claude', worktree: true });
    const live = await sessions.create({ workspaceId, name: 'live', agent: 'claude', worktree: true });
    await sessions.kill(workspaceId, 'dead', { removeWorktree: false });

    const result = await collectGarbage(db, fx.root, workspaceId);

    expect(result.removed).toEqual(['dead']);
    expect(result.reclaimedBytes).toBeGreaterThan(0);
    expect(existsSync(dead.worktreePath ?? '')).toBe(false);
    expect(existsSync(live.worktreePath ?? '')).toBe(true);
    expect(sessions.list(workspaceId).map((s) => s.name)).toEqual(['live']);
  }, 30_000);

  it('is a no-op when nothing has ended', async () => {
    await sessions.create({ workspaceId, name: 'live', agent: 'claude', worktree: true });
    const result = await collectGarbage(db, fx.root, workspaceId);
    expect(result.removed).toEqual([]);
    expect(result.reclaimedBytes).toBe(0);
  }, 30_000);

  it('deletes the dead session\'s branch too, freeing the name', async () => {
    await sessions.create({ workspaceId, name: 'recycle', agent: 'claude', worktree: true });
    await sessions.kill(workspaceId, 'recycle', { removeWorktree: false });
    await collectGarbage(db, fx.root, workspaceId);

    const { simpleGit } = await import('simple-git');
    expect((await simpleGit(fx.root).branch()).all).not.toContain('cw/recycle');
    const revived = await sessions.create({ workspaceId, name: 'recycle', agent: 'claude', worktree: true });
    expect(revived.branch).toBe('cw/recycle');
  }, 30_000);

  it('reclaims worktrees no session row claims', async () => {
    await sessions.create({ workspaceId, name: 'orphan', agent: 'claude', worktree: true });
    // Simulate what `workspace delete --force` leaves: the row is gone, the disk is not.
    const row = sessions.resolve(workspaceId, 'orphan');
    new SessionRepo(db).delete(row.id);
    expect(existsSync(row.worktreePath ?? '')).toBe(true);

    // Age it past the orphan-sweep grace window — a directory this fresh is
    // indistinguishable from one whose `create()` call just hasn't inserted its row
    // yet, and the sweep must not touch it. See the next test for that case.
    const old = new Date(Date.now() - 10_000);
    utimesSync(row.worktreePath ?? '', old, old);

    const result = await collectGarbage(db, fx.root, workspaceId);
    expect(result.removed).toHaveLength(1);
    expect(existsSync(row.worktreePath ?? '')).toBe(false);
  }, 30_000);

  it('does not reclaim a worktree that is still mid-creation', async () => {
    await sessions.create({ workspaceId, name: 'brand-new', agent: 'claude', worktree: true });
    // Same shape as a genuine orphan — the row is gone, the disk is not — but the
    // directory's mtime is fresh, as it would be for a `create()` call caught between
    // `createWorktree` returning and `sessions.insert` committing.
    const row = sessions.resolve(workspaceId, 'brand-new');
    new SessionRepo(db).delete(row.id);

    const result = await collectGarbage(db, fx.root, workspaceId);
    expect(result.removed).toEqual([]);
    expect(existsSync(row.worktreePath ?? '')).toBe(true);
  }, 30_000);
});
