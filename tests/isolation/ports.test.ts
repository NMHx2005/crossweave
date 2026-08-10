import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { LeaseRepo } from '../../src/db/repositories/lease.js';
import { allocatePortBlock } from '../../src/isolation/leases/ports.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { newId } from '../../src/core/ids.js';

let dir: string;
let db: Database;
let leases: LeaseRepo;
let sessionId: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cw-ports-'));
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
    tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
  });
  leases = new LeaseRepo(db);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('allocatePortBlock', () => {
  it('returns the configured base when nothing is taken', async () => {
    expect(await allocatePortBlock(leases, DEFAULT_CONFIG)).toBe(DEFAULT_CONFIG.ports.base);
  });

  it('skips a block already leased', async () => {
    leases.insert({
      id: newId('ev'), sessionId, kind: 'port', value: String(DEFAULT_CONFIG.ports.base),
      acquiredAt: '2026-08-10T00:00:00.000Z', releasedAt: null,
    });
    expect(await allocatePortBlock(leases, DEFAULT_CONFIG)).toBe(
      DEFAULT_CONFIG.ports.base + DEFAULT_CONFIG.ports.blockSize,
    );
  });

  it('reuses a block whose lease was released', async () => {
    leases.insert({
      id: newId('ev'), sessionId, kind: 'port', value: String(DEFAULT_CONFIG.ports.base),
      acquiredAt: '2026-08-10T00:00:00.000Z', releasedAt: null,
    });
    leases.release(sessionId);
    expect(await allocatePortBlock(leases, DEFAULT_CONFIG)).toBe(DEFAULT_CONFIG.ports.base);
  });

  // A lease table free of a port does not make the port free: another program on the
  // machine may hold it, and handing it to an agent produces an EADDRINUSE the user
  // cannot explain.
  it('skips a block whose first port is held by another process', async () => {
    const base = DEFAULT_CONFIG.ports.base;
    const squatter = createServer();
    await new Promise<void>((resolve, reject) => {
      squatter.once('error', reject);
      squatter.listen(base, '127.0.0.1', () => resolve());
    });
    try {
      expect(await allocatePortBlock(leases, DEFAULT_CONFIG)).toBe(
        base + DEFAULT_CONFIG.ports.blockSize,
      );
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });

  it('throws when the range is exhausted', async () => {
    const tiny = {
      ...DEFAULT_CONFIG,
      ports: { base: 43000, blockSize: 10, named: {} },
    };
    // Fill every block the range can hold by leasing them all.
    for (let p = 43000; p + 10 <= 65535; p += 10) {
      leases.insert({
        id: newId('ev'), sessionId, kind: 'port', value: String(p),
        acquiredAt: '2026-08-10T00:00:00.000Z', releasedAt: null,
      });
    }
    await expect(allocatePortBlock(leases, tiny)).rejects.toMatchObject({
      code: 'NO_PORTS_AVAILABLE',
    });
  }, 30_000);
});
