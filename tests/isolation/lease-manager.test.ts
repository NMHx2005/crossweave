import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { LeaseRepo } from '../../src/db/repositories/lease.js';
import { LeaseManager } from '../../src/isolation/leases/manager.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { newId } from '../../src/core/ids.js';

let dir: string;
let db: Database;
let manager: LeaseManager;
let sessionA: string;
let sessionB: string;

function addSession(workspaceId: string, name: string): string {
  const id = newId('s');
  new SessionRepo(db).insert({
    id, workspaceId, name, agentKind: 'claude', adapter: 'claude', status: 'idle',
    worktreePath: null, branch: null,
    createdAt: '2026-08-10T00:00:00.000Z', lastActiveAt: '2026-08-10T00:00:00.000Z',
    tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
  });
  return id;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cw-leasemgr-'));
  db = openDatabase(join(dir, '.crossweave', 'state.db'));
  const workspaceId = newId('ws');
  new WorkspaceRepo(db).insert({
    id: workspaceId, name: 'demo', rootPath: dir,
    createdAt: '2026-08-10T00:00:00.000Z', defaultIsolation: 'worktree', safeModeTier: 'T3',
  });
  sessionA = addSession(workspaceId, 'a');
  sessionB = addSession(workspaceId, 'b');
  manager = new LeaseManager(db, dir, DEFAULT_CONFIG);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('LeaseManager', () => {
  it('injects a port block, a docker project and a cache directory', async () => {
    const env = await manager.acquire(sessionA);

    expect(Number(env.CW_PORT_BASE)).toBe(DEFAULT_CONFIG.ports.base);
    expect(env.PORT).toBe(env.CW_PORT_BASE);
    expect(env.COMPOSE_PROJECT_NAME).toBe(`cw_${sessionA}`);
    expect(env.XDG_CACHE_HOME).toContain(sessionA);
    expect(existsSync(env.XDG_CACHE_HOME ?? '')).toBe(true);
  });

  it('gives two concurrent sessions non-overlapping ports and caches', async () => {
    const a = await manager.acquire(sessionA);
    const b = await manager.acquire(sessionB);

    expect(a.CW_PORT_BASE).not.toBe(b.CW_PORT_BASE);
    expect(Math.abs(Number(a.CW_PORT_BASE) - Number(b.CW_PORT_BASE)))
      .toBeGreaterThanOrEqual(DEFAULT_CONFIG.ports.blockSize);
    expect(a.XDG_CACHE_HOME).not.toBe(b.XDG_CACHE_HOME);
    expect(a.COMPOSE_PROJECT_NAME).not.toBe(b.COMPOSE_PROJECT_NAME);
  });

  it('exposes named ports as offsets from the block base', async () => {
    const config = {
      ...DEFAULT_CONFIG,
      ports: { ...DEFAULT_CONFIG.ports, named: { API_PORT: 0, DB_PORT: 1 } },
    };
    const named = new LeaseManager(db, dir, config);
    const env = await named.acquire(sessionA);
    expect(Number(env.API_PORT)).toBe(Number(env.CW_PORT_BASE));
    expect(Number(env.DB_PORT)).toBe(Number(env.CW_PORT_BASE) + 1);
  });

  it('releases everything, freeing the block for reuse', async () => {
    const a = await manager.acquire(sessionA);
    manager.release(sessionA);
    const b = await manager.acquire(sessionB);
    expect(b.CW_PORT_BASE).toBe(a.CW_PORT_BASE);
  });

  it('records one lease row per kind', async () => {
    await manager.acquire(sessionA);
    const kinds = new LeaseRepo(db).listBySession(sessionA).map((l) => l.kind).sort();
    expect(kinds).toEqual(['cache', 'docker', 'port']);
  });

  it('does not set DATABASE_URL under the default none strategy', async () => {
    const env = await manager.acquire(sessionA);
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it('sets DATABASE_URL under the file-copy strategy', async () => {
    const config = { ...DEFAULT_CONFIG, db: { strategy: 'file-copy' as const, url: 'app.db' } };
    const withDb = new LeaseManager(db, dir, config);
    const env = await withDb.acquire(sessionA);
    expect(env.DATABASE_URL).toContain(sessionA);
    expect(new LeaseRepo(db).listBySession(sessionA).map((l) => l.kind)).toContain('db');
  });

  it('releaseAll clears leases left by a previous daemon', async () => {
    await manager.acquire(sessionA);
    manager.releaseAll();
    const env = await manager.acquire(sessionB);
    expect(env.CW_PORT_BASE).toBe(String(DEFAULT_CONFIG.ports.base));
  });
});
