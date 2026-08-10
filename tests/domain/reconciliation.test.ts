import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceManager } from '../../src/domain/workspace.js';
import { SessionManager } from '../../src/domain/session.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { LeaseRepo } from '../../src/db/repositories/lease.js';
import { reconcile } from '../../src/domain/reconciliation.js';
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

describe('reconcile', () => {
  it('marks a running session dead when its worktree is gone', async () => {
    const session = await sessions.create({ workspaceId, name: 'a', agent: 'claude', worktree: true });
    new SessionRepo(db).updateStatus(session.id, 'running', 99999);
    if (session.worktreePath !== null) await rm(session.worktreePath, { recursive: true, force: true });

    reconcile(db, fx.root);

    expect(sessions.resolve(workspaceId, session.id).status).toBe('dead');
  }, 30_000);

  it('marks a running session dead when its recorded pid is not alive', async () => {
    const session = await sessions.create({ workspaceId, name: 'a', agent: 'claude', worktree: true });
    // A pid this high is essentially guaranteed not to exist.
    new SessionRepo(db).updateStatus(session.id, 'running', 9_999_999);

    reconcile(db, fx.root);

    expect(sessions.resolve(workspaceId, session.id).status).toBe('dead');
  }, 30_000);

  it('leaves an idle session alone', async () => {
    const session = await sessions.create({ workspaceId, name: 'a', agent: 'claude', worktree: true });
    reconcile(db, fx.root);
    expect(sessions.resolve(workspaceId, session.id).status).toBe('idle');
  }, 30_000);

  it('releases leases for a session it marks dead', async () => {
    const session = await sessions.create({ workspaceId, name: 'a', agent: 'claude', worktree: true });
    new SessionRepo(db).updateStatus(session.id, 'running', 9_999_999);
    const leases = new LeaseRepo(db);
    leases.insert({
      id: 'lease_test', sessionId: session.id, kind: 'port', value: '43000',
      acquiredAt: '2026-08-10T00:00:00.000Z', releasedAt: null,
    });

    reconcile(db, fx.root);

    expect(leases.listActive('port')).toHaveLength(0);
  }, 30_000);
});
