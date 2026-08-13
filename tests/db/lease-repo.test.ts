import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { LeaseRepo, type LeaseRow } from '../../src/db/repositories/lease.js';
import { newId } from '../../src/core/ids.js';

let dir: string;
let db: Database;
let leases: LeaseRepo;
let sessionId: string;

function makeLease(overrides: Partial<LeaseRow> = {}): LeaseRow {
  return {
    id: newId('lease'),
    sessionId,
    kind: 'port',
    value: '43000',
    acquiredAt: '2026-08-10T00:00:00.000Z',
    releasedAt: null,
    ...overrides,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cw-lease-'));
  db = openDatabase(join(dir, 'state.db'));
  const workspaceId = newId('ws');
  new WorkspaceRepo(db).insert({
    id: workspaceId, name: 'demo', rootPath: join(dir, 'proj'),
    createdAt: '2026-08-10T00:00:00.000Z', defaultIsolation: 'worktree', safeModeTier: 'T3',
  });
  sessionId = newId('s');
  new SessionRepo(db).insert({
    id: sessionId, workspaceId, name: 'auth', agentKind: 'claude', adapter: 'claude',
    status: 'idle', worktreePath: null, branch: null,
    createdAt: '2026-08-10T00:00:00.000Z', lastActiveAt: '2026-08-10T00:00:00.000Z',
    tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null, enforcementTier: 'T3', pid: null,
  });
  leases = new LeaseRepo(db);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('LeaseRepo', () => {
  it('round-trips a lease', () => {
    const row = makeLease();
    leases.insert(row);
    expect(leases.listBySession(sessionId)).toEqual([row]);
  });

  it('listActive excludes released leases and other kinds', () => {
    leases.insert(makeLease({ value: '43000' }));
    leases.insert(makeLease({ id: newId('lease'), kind: 'cache', value: '/tmp/c' }));
    const released = makeLease({ id: newId('lease'), value: '43010' });
    leases.insert(released);
    leases.release(sessionId);

    expect(leases.listActive('port')).toHaveLength(0);

    const fresh = makeLease({ id: newId('lease'), value: '43020' });
    leases.insert(fresh);
    expect(leases.listActive('port').map((l) => l.value)).toEqual(['43020']);
  });

  it('release is idempotent and stamps a time', () => {
    leases.insert(makeLease());
    leases.release(sessionId);
    const after = leases.listBySession(sessionId);
    expect(after[0]?.releasedAt).not.toBeNull();
    const stamp = after[0]?.releasedAt;
    leases.release(sessionId);
    expect(leases.listBySession(sessionId)[0]?.releasedAt).toBe(stamp ?? '');
  });

  it('releaseAll clears every outstanding lease', () => {
    leases.insert(makeLease());
    leases.insert(makeLease({ id: newId('lease'), kind: 'docker', value: 'cw_x' }));
    leases.releaseAll();
    expect(leases.listActive('port')).toHaveLength(0);
    expect(leases.listActive('docker')).toHaveLength(0);
  });

  it('cascades when the session is deleted', () => {
    leases.insert(makeLease());
    new SessionRepo(db).delete(sessionId);
    expect(leases.listBySession(sessionId)).toHaveLength(0);
  });
});
