import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo, type SessionRow } from '../../src/db/repositories/session.js';
import { newId } from '../../src/core/ids.js';

let dir: string;
let db: Database;
let repo: SessionRepo;
let workspaceId: string;

function makeRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: newId('s'),
    workspaceId,
    name: 'auth',
    agentKind: 'claude',
    adapter: 'claude-pty',
    status: 'idle',
    worktreePath: '/tmp/wt',
    branch: 'cw/auth',
    createdAt: '2026-08-09T00:00:00.000Z',
    lastActiveAt: '2026-08-09T00:00:00.000Z',
    tokenBudget: null,
    tokenSpent: 0, costBudgetUsd: null, costSpentUsd: 0,
    enforcementTier: 'T3',
    pid: null,
    ...overrides,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cw-srepo-'));
  db = openDatabase(join(dir, 'state.db'));
  workspaceId = newId('ws');
  new WorkspaceRepo(db).insert({
    id: workspaceId,
    name: 'demo',
    rootPath: '/tmp/demo',
    createdAt: '2026-08-09T00:00:00.000Z',
    defaultIsolation: 'worktree',
    safeModeTier: 'T3',
  });
  repo = new SessionRepo(db);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('SessionRepo', () => {
  it('round-trips a row', () => {
    const row = makeRow();
    repo.insert(row);
    expect(repo.findById(row.id)).toEqual(row);
  });

  it('round-trips cost columns', () => {
    const row = makeRow({ costBudgetUsd: 5, costSpentUsd: 1.2345 });
    repo.insert(row);
    expect(repo.findById(row.id)).toEqual(row);
  });

  it('updateUsage writes only the provided fields, leaving the other untouched', () => {
    const row = makeRow({ tokenSpent: 0, costSpentUsd: 0 });
    repo.insert(row);

    repo.updateUsage(row.id, { tokensSpent: 15500 });
    let after = repo.findById(row.id)!;
    expect(after.tokenSpent).toBe(15500);
    expect(after.costSpentUsd).toBe(0);

    repo.updateUsage(row.id, { costSpentUsd: 0.0123 });
    after = repo.findById(row.id)!;
    expect(after.tokenSpent).toBe(15500);
    expect(after.costSpentUsd).toBeCloseTo(0.0123);
  });

  it('updateUsage with both fields updates both together', () => {
    const row = makeRow();
    repo.insert(row);
    repo.updateUsage(row.id, { tokensSpent: 100, costSpentUsd: 0.5 });
    const after = repo.findById(row.id)!;
    expect(after.tokenSpent).toBe(100);
    expect(after.costSpentUsd).toBe(0.5);
  });

  it('updateUsage with neither field is a no-op', () => {
    const row = makeRow({ tokenSpent: 7, costSpentUsd: 0.1 });
    repo.insert(row);
    repo.updateUsage(row.id, {});
    const after = repo.findById(row.id)!;
    expect(after.tokenSpent).toBe(7);
    expect(after.costSpentUsd).toBe(0.1);
  });

  it('updateUsage against an unknown id is a silent no-op, not a throw', () => {
    expect(() => repo.updateUsage('s_ghost', { tokensSpent: 1 })).not.toThrow();
  });

  it('finds by name within a workspace', () => {
    const row = makeRow({ name: 'tests' });
    repo.insert(row);
    expect(repo.findByName(workspaceId, 'tests')?.id).toBe(row.id);
    expect(repo.findByName(workspaceId, 'nope')).toBeUndefined();
  });

  it('rejects a duplicate name in the same workspace', () => {
    repo.insert(makeRow({ name: 'dup' }));
    expect(() => repo.insert(makeRow({ name: 'dup' }))).toThrow();
  });

  it('updates status and pid together', () => {
    const row = makeRow();
    repo.insert(row);
    repo.updateStatus(row.id, 'running', 4242);
    const after = repo.findById(row.id);
    expect(after).toBeDefined();
    expect(after!.status).toBe('running');
    expect(after!.pid).toBe(4242);
    expect(after!.lastActiveAt >= row.lastActiveAt).toBe(true);
  });

  it('lists only live sessions', () => {
    const a = makeRow({ name: 'a', status: 'running' });
    const b = makeRow({ name: 'b', status: 'dead' });
    const c = makeRow({ name: 'c', status: 'landed' });
    repo.insert(a); repo.insert(b); repo.insert(c);
    expect(repo.listLive(workspaceId).map((s) => s.name)).toEqual(['a']);
  });

  it('renames a session', () => {
    const row = makeRow();
    repo.insert(row);
    repo.rename(row.id, 'renamed');
    expect(repo.findById(row.id)?.name).toBe('renamed');
  });

  it('cascades delete when the workspace is removed', () => {
    const row = makeRow();
    repo.insert(row);
    new WorkspaceRepo(db).delete(workspaceId);
    expect(repo.findById(row.id)).toBeUndefined();
  });

  it('clears the worktree path', () => {
    const row = makeRow();
    repo.insert(row);
    repo.clearWorktree(row.id);
    expect(repo.findById(row.id)?.worktreePath).toBeNull();
  });
});
