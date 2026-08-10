import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { measureWorktrees, assertDiskAvailable } from '../../src/isolation/disk-guard.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { newId } from '../../src/core/ids.js';
import { makeGitFixture, type GitFixture } from '../helpers/git-fixture.js';

let fx: GitFixture;
let db: Database;
let workspaceId: string;

async function addSessionWithBytes(name: string, bytes: number): Promise<string> {
  const id = newId('s');
  const path = join(fx.root, '.crossweave', 'worktrees', id);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'blob'), Buffer.alloc(bytes));
  new SessionRepo(db).insert({
    id, workspaceId, name, agentKind: 'claude', adapter: 'claude', status: 'idle',
    worktreePath: path, branch: `cw/${name}`,
    createdAt: '2026-08-10T00:00:00.000Z', lastActiveAt: '2026-08-10T00:00:00.000Z',
    tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
  });
  return id;
}

beforeEach(async () => {
  fx = await makeGitFixture();
  db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
  workspaceId = newId('ws');
  new WorkspaceRepo(db).insert({
    id: workspaceId, name: 'demo', rootPath: fx.root,
    createdAt: '2026-08-10T00:00:00.000Z', defaultIsolation: 'worktree', safeModeTier: 'T3',
  });
});

afterEach(async () => {
  db.close();
  await fx.cleanup();
});

describe('measureWorktrees', () => {
  it('reports a size per session', async () => {
    await addSessionWithBytes('a', 4096);
    await addSessionWithBytes('b', 8192);
    const usage = measureWorktrees(db, workspaceId);
    expect(usage).toHaveLength(2);
    expect(usage.find((u) => u.name === 'b')?.bytes).toBeGreaterThanOrEqual(8192);
  });

  it('reports zero for a session whose worktree is gone', async () => {
    const id = await addSessionWithBytes('c', 1024);
    await rm(join(fx.root, '.crossweave', 'worktrees', id), { recursive: true, force: true });
    expect(measureWorktrees(db, workspaceId).find((u) => u.name === 'c')?.bytes).toBe(0);
  });
});

describe('assertDiskAvailable', () => {
  it('passes under the limits', async () => {
    await addSessionWithBytes('small', 1024);
    expect(() => assertDiskAvailable(db, workspaceId, DEFAULT_CONFIG)).not.toThrow();
  });

  it('refuses when one session exceeds the per-session limit', async () => {
    await addSessionWithBytes('fat', 64 * 1024);
    const config = {
      ...DEFAULT_CONFIG,
      disk: { perSessionBytes: 8 * 1024, perWorkspaceBytes: 1024 * 1024 },
    };
    expect(() => assertDiskAvailable(db, workspaceId, config)).toThrowError(
      expect.objectContaining({ code: 'DISK_LIMIT_EXCEEDED' }) as unknown as Error,
    );
  });

  it('refuses when the workspace total exceeds its limit', async () => {
    await addSessionWithBytes('one', 32 * 1024);
    await addSessionWithBytes('two', 32 * 1024);
    const config = {
      ...DEFAULT_CONFIG,
      disk: { perSessionBytes: 1024 * 1024, perWorkspaceBytes: 40 * 1024 },
    };
    expect(() => assertDiskAvailable(db, workspaceId, config)).toThrowError(
      expect.objectContaining({ code: 'DISK_LIMIT_EXCEEDED' }) as unknown as Error,
    );
  });

  it('names the offender and points at gc', async () => {
    await addSessionWithBytes('hog', 64 * 1024);
    const config = {
      ...DEFAULT_CONFIG,
      disk: { perSessionBytes: 8 * 1024, perWorkspaceBytes: 1024 * 1024 },
    };
    try {
      assertDiskAvailable(db, workspaceId, config);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('hog');
      expect((err as Error).message).toContain('cw gc');
    }
  });
});
