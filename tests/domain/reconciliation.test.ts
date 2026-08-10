import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { rm } from 'node:fs/promises';
import { existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceManager } from '../../src/domain/workspace.js';
import { SessionManager } from '../../src/domain/session.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { LeaseRepo } from '../../src/db/repositories/lease.js';
import { reconcile } from '../../src/domain/reconciliation.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { collectGarbage } from '../../src/domain/gc.js';
import { ClaudePtyAdapter } from '../../src/adapters/claude-pty.js';
import { CrossweaveError } from '../../src/core/errors.js';
import type { AgentAdapter } from '../../src/adapters/types.js';
import type { MethodContext } from '../../src/daemon/server.js';
import { makeGitFixture, type GitFixture } from '../helpers/git-fixture.js';

/** Never spawns the real `claude` binary — see tests/daemon/runtime.test.ts's identical helper. */
function echoFactory(kind: string): AgentAdapter {
  if (kind !== 'claude') throw new CrossweaveError('UNKNOWN_AGENT', `Unsupported: ${kind}`);
  return new ClaudePtyAdapter('sh', ['-c', 'while IFS= read -r l; do eval "echo echo:$l"; done']);
}

const noopCtx: MethodContext = { notify: () => undefined, onClose: () => undefined };

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

  it('marks a running session idle (not dead) when its pid is gone but its worktree still exists', async () => {
    // A daemon crash or an ordinary restart must not be indistinguishable from a
    // deliberate `cw session kill`: the worktree is still there, so the work is
    // still resumable, exactly like `cw session stop` already leaves it.
    const session = await sessions.create({ workspaceId, name: 'a', agent: 'claude', worktree: true });
    // A pid this high is essentially guaranteed not to exist.
    new SessionRepo(db).updateStatus(session.id, 'running', 9_999_999);

    reconcile(db, fx.root);

    const resolved = sessions.resolve(workspaceId, session.id);
    expect(resolved.status).toBe('idle');
    expect(resolved.pid).toBeNull();
  }, 30_000);

  it('leaves an idle session alone', async () => {
    const session = await sessions.create({ workspaceId, name: 'a', agent: 'claude', worktree: true });
    reconcile(db, fx.root);
    expect(sessions.resolve(workspaceId, session.id).status).toBe('idle');
  }, 30_000);

  it('releases leases for a session it marks dead (worktree gone)', async () => {
    const session = await sessions.create({ workspaceId, name: 'a', agent: 'claude', worktree: true });
    new SessionRepo(db).updateStatus(session.id, 'running', 99999);
    if (session.worktreePath !== null) await rm(session.worktreePath, { recursive: true, force: true });
    const leases = new LeaseRepo(db);
    leases.insert({
      id: 'lease_test', sessionId: session.id, kind: 'port', value: '43000',
      acquiredAt: '2026-08-10T00:00:00.000Z', releasedAt: null,
    });

    reconcile(db, fx.root);

    expect(leases.listActive('port')).toHaveLength(0);
    expect(sessions.resolve(workspaceId, session.id).status).toBe('dead');
  }, 30_000);

  it('releases leases for a session it marks idle (pid gone, worktree intact)', async () => {
    const session = await sessions.create({ workspaceId, name: 'a', agent: 'claude', worktree: true });
    new SessionRepo(db).updateStatus(session.id, 'running', 9_999_999);
    const leases = new LeaseRepo(db);
    leases.insert({
      id: 'lease_test', sessionId: session.id, kind: 'port', value: '43000',
      acquiredAt: '2026-08-10T00:00:00.000Z', releasedAt: null,
    });

    reconcile(db, fx.root);

    expect(leases.listActive('port')).toHaveLength(0);
    expect(sessions.resolve(workspaceId, session.id).status).toBe('idle');
  }, 30_000);
});

describe('reconcile wired into daemon boot (regression: an ordinary restart must not destroy running work)', () => {
  it('a session that was `running` when the daemon died survives a restart: resumable, and untouched by gc', async () => {
    const session = await sessions.create({ workspaceId, name: 'survivor', agent: 'claude', worktree: true });
    // Simulate the process that was supervising this session dying along with the
    // daemon — the row still says `running` with a pid nothing holds, but the
    // worktree (the actual work) is untouched, exactly like a host reboot or a
    // `cw daemon stop` for an upgrade.
    new SessionRepo(db).updateStatus(session.id, 'running', 9_999_999);

    // What an ordinary daemon restart does against the same database: a fresh
    // `buildMethods` call, which runs `reconcile()` once at boot exactly like a
    // real restart would.
    const methods = buildMethods(db, fx.root, echoFactory);

    expect(sessions.resolve(workspaceId, session.id).status).toBe('idle');

    // Resumable: `session.resume` must actually succeed, not throw SESSION_ENDED.
    const resumeHandler = methods['session.resume'];
    if (!resumeHandler) throw new Error('expected session.resume to be registered');
    const resumed = (await resumeHandler(
      { workspaceId, idOrName: 'survivor', env: {} },
      noopCtx,
    )) as { status: string };
    expect(resumed.status).toBe('running');

    const stopHandler = methods['session.stop'];
    if (!stopHandler) throw new Error('expected session.stop to be registered');
    await stopHandler({ workspaceId, idOrName: 'survivor' }, noopCtx);

    // gc-safe: `collectGarbage` must not reclaim a resumable session's worktree/branch.
    if (session.worktreePath !== null) {
      const old = new Date(Date.now() - 10_000);
      utimesSync(session.worktreePath, old, old);
    }
    await collectGarbage(db, workspaceId);
    expect(existsSync(session.worktreePath ?? '')).toBe(true);
    expect(sessions.resolve(workspaceId, session.id).status).not.toBe('dead');
  }, 30_000);
});
