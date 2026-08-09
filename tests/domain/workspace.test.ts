import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
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
    expect(ws.safeModeTier).toBe('T3');
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
      tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
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
      tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
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
});
