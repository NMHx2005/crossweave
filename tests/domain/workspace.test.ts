import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { WorkspaceRepo, type WorkspaceRow } from '../../src/db/repositories/workspace.js';
import { WorkspaceManager } from '../../src/domain/workspace.js';
import { newId } from '../../src/core/ids.js';

let dir: string;
let db: Database;
let mgr: WorkspaceManager;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cw-wsmgr-'));
  db = openDatabase(join(dir, 'state.db'));
  mgr = new WorkspaceManager(db);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('WorkspaceManager.init', () => {
  it('defaults the name to the project directory basename', () => {
    const ws = mgr.init('/tmp/projects/my-app');
    expect(ws.name).toBe('my-app');
    expect(ws.rootPath).toBe('/tmp/projects/my-app');
    expect(ws.defaultIsolation).toBe('worktree');
    expect(ws.safeModeTier).toBe('T2');
  });

  it('honours an explicit name', () => {
    expect(mgr.init('/tmp/projects/my-app', 'custom').name).toBe('custom');
  });

  it('is idempotent for the same root', () => {
    const a = mgr.init('/tmp/projects/my-app');
    const b = mgr.init('/tmp/projects/my-app');
    expect(b.id).toBe(a.id);
    expect(mgr.list()).toHaveLength(1);
  });
});

describe('WorkspaceManager.resolve', () => {
  it('resolves by name and by id', () => {
    const ws = mgr.init('/tmp/projects/app', 'alpha');
    expect(mgr.resolve('alpha').id).toBe(ws.id);
    expect(mgr.resolve(ws.id).id).toBe(ws.id);
  });

  it('throws WORKSPACE_NOT_FOUND for an unknown name', () => {
    expect(() => mgr.resolve('ghost')).toThrowError(
      expect.objectContaining({ code: 'WORKSPACE_NOT_FOUND' }) as unknown as Error,
    );
  });
});

describe('WorkspaceManager.delete', () => {
  it('refuses while live sessions exist', () => {
    const ws = mgr.init('/tmp/projects/app');
    new SessionRepo(db).insert({
      id: newId('s'), workspaceId: ws.id, name: 'auth', agentKind: 'claude',
      adapter: 'claude-pty', status: 'running', worktreePath: null, branch: null,
      createdAt: '2026-08-09T00:00:00.000Z', lastActiveAt: '2026-08-09T00:00:00.000Z',
      tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null, enforcementTier: 'T3', pid: null,
    });
    expect(() => mgr.delete(ws.id, {})).toThrowError(
      expect.objectContaining({ code: 'WORKSPACE_HAS_LIVE_SESSIONS' }) as unknown as Error,
    );
    expect(mgr.list()).toHaveLength(1);
  });

  it('deletes with force even when live sessions exist', () => {
    const ws = mgr.init('/tmp/projects/app');
    new SessionRepo(db).insert({
      id: newId('s'), workspaceId: ws.id, name: 'auth', agentKind: 'claude',
      adapter: 'claude-pty', status: 'running', worktreePath: null, branch: null,
      createdAt: '2026-08-09T00:00:00.000Z', lastActiveAt: '2026-08-09T00:00:00.000Z',
      tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null, enforcementTier: 'T3', pid: null,
    });
    mgr.delete(ws.id, { force: true });
    expect(mgr.list()).toHaveLength(0);
  });

  it('deletes cleanly when no sessions are live', () => {
    const ws = mgr.init('/tmp/projects/app');
    mgr.delete(ws.id, {});
    expect(mgr.list()).toHaveLength(0);
  });
});

describe('WorkspaceManager.info', () => {
  it('returns the workspace with its sessions', () => {
    const ws = mgr.init('/tmp/projects/app');
    expect(mgr.info(ws.id)).toEqual({ workspace: ws, sessions: [] });
  });

  it('never includes the integration-kind session row', () => {
    const ws = mgr.init('/tmp/projects/app');
    new SessionRepo(db).insert({
      id: newId('s'), workspaceId: ws.id, name: '__integration__', agentKind: 'integration',
      adapter: 'integration', status: 'idle', worktreePath: '/tmp/integration', branch: 'cw/integration',
      createdAt: '2026-08-09T00:00:00.000Z', lastActiveAt: '2026-08-09T00:00:00.000Z',
      tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null, enforcementTier: 'T3', pid: null,
    });
    expect(mgr.info(ws.id).sessions).toHaveLength(0);
  });
});

describe('WorkspaceManager identity and ambiguity', () => {
  // Regression: root_path is a workspace's identity, so it must be compared in one
  // spelling. Reaching the same directory through a symlink used to create a second
  // workspace for it.
  it('treats a symlinked root as the same workspace', async () => {
    const real = await mkdtemp(join(tmpdir(), 'cw-real-'));
    const linkDir = await mkdtemp(join(tmpdir(), 'cw-link-'));
    const alias = join(linkDir, 'alias');
    await symlink(real, alias);
    try {
      const a = mgr.init(real);
      const b = mgr.init(alias);
      expect(b.id).toBe(a.id);
      expect(mgr.list()).toHaveLength(1);
    } finally {
      await rm(real, { recursive: true, force: true });
      await rm(linkDir, { recursive: true, force: true });
    }
  });

  it('leaves a path that does not exist exactly as given', () => {
    expect(mgr.init('/tmp/projects/never-created').rootPath).toBe('/tmp/projects/never-created');
  });

  it('returns the existing row and ignores a different name for the same root', () => {
    const first = mgr.init('/tmp/projects/app', 'original');
    const second = mgr.init('/tmp/projects/app', 'renamed');
    expect(second.id).toBe(first.id);
    expect(second.name).toBe('original');
  });

  // Regression: a concurrent writer between init's read and its write used to
  // surface a raw SQLiteError naming a table column. Stubbing findByRoot to miss
  // once reproduces exactly that window.
  it('returns the winner when a concurrent writer takes the root first', () => {
    const root = '/tmp/projects/raced';
    new WorkspaceRepo(db).insert({
      id: newId('ws'), name: 'winner', rootPath: root,
      createdAt: '2026-08-09T00:00:00.000Z',
      defaultIsolation: 'worktree', safeModeTier: 'T3',
    });

    const internals = mgr as unknown as { workspaces: WorkspaceRepo };
    const real = internals.workspaces.findByRoot.bind(internals.workspaces);
    let missed = false;
    internals.workspaces.findByRoot = (p: string): WorkspaceRow | undefined => {
      if (!missed) { missed = true; return undefined; }
      return real(p);
    };

    expect(mgr.init(root, 'loser').name).toBe('winner');
  });

  it('refuses to resolve an ambiguous name instead of guessing', () => {
    mgr.init('/tmp/projects/one', 'shared');
    mgr.init('/tmp/projects/two', 'shared');
    expect(() => mgr.resolve('shared')).toThrowError(
      expect.objectContaining({ code: 'WORKSPACE_NAME_AMBIGUOUS' }) as unknown as Error,
    );
  });

  it('still resolves a unique name, and id always wins', () => {
    const only = mgr.init('/tmp/projects/solo', 'solo');
    expect(mgr.resolve('solo').id).toBe(only.id);
    expect(mgr.resolve(only.id).id).toBe(only.id);
  });
});

describe('WorkspaceManager.setSafeMode', () => {
  it('sets T2 and persists it', () => {
    const ws = mgr.init('/tmp/projects/app');
    const updated = mgr.setSafeMode(ws.id, 'T2');
    expect(updated.safeModeTier).toBe('T2');
    expect(mgr.resolve(ws.id).safeModeTier).toBe('T2');
  });

  it('sets T3 and persists it', () => {
    const ws = mgr.init('/tmp/projects/app');
    const updated = mgr.setSafeMode(ws.id, 'T3');
    expect(updated.safeModeTier).toBe('T3');
    expect(mgr.resolve(ws.id).safeModeTier).toBe('T3');
  });

  it('accepts T1, now that AcpAdapter exists', () => {
    const ws = mgr.init('/tmp/projects/app');
    const updated = mgr.setSafeMode(ws.id, 'T1');
    expect(updated.safeModeTier).toBe('T1');
    expect(mgr.resolve(ws.id).safeModeTier).toBe('T1');
  });

  it('rejects garbage input with INVALID_PARAMS', () => {
    const ws = mgr.init('/tmp/projects/app');
    expect(() => mgr.setSafeMode(ws.id, 'nope')).toThrowError(
      expect.objectContaining({ code: 'INVALID_PARAMS' }) as unknown as Error,
    );
  });

  it('throws WORKSPACE_NOT_FOUND for an unknown workspace', () => {
    expect(() => mgr.setSafeMode('ghost', 'T2')).toThrowError(
      expect.objectContaining({ code: 'WORKSPACE_NOT_FOUND' }) as unknown as Error,
    );
  });
});
