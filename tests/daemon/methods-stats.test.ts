import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { SessionHistoryRepo } from '../../src/db/repositories/session-history.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';

const ctx = { notify: () => undefined, onClose: () => undefined };
const codeOf = async (fn: () => unknown): Promise<string> => { try { await fn(); return 'ok'; } catch (e) { return (e as { code?: string }).code ?? 'no-code'; } };

interface Overview {
  workspaceId: string;
  root: string;
  measuredAt: number;
  process: { pid: number; uptimeMs: number; rssBytes: number; heapUsedBytes: number };
  running: number;
  terminals: number;
  limits: { perSessionBytes: number; perWorkspaceBytes: number };
  sessions: Array<{
    id: string; name: string; status: string; shared: boolean; diskBytes: number | null; diskMeasuring: boolean; diskApprox: boolean;
    ahead: number | null; changed: number | null; createdAt: string; lastActiveAt: string;
  }>;
  startedPerDay: Record<string, number>;
  landedPerDay: Record<string, number>;
}

function setup(rootPath: string) {
  const db = openDatabase(':memory:');
  new WorkspaceRepo(db).insert({ id: 'ws_1', name: 'w', rootPath, createdAt: 'now', defaultIsolation: 'worktree', safeModeTier: 'T2' });
  const sessions = new SessionRepo(db);
  const add = (id: string, worktreePath: string | null, over: { status?: 'idle' | 'running' | 'dead' | 'landed'; createdAt?: string } = {}) => sessions.insert({
    id, workspaceId: 'ws_1', name: id, agentKind: 'shell', adapter: 'shell', status: over.status ?? 'idle', worktreePath, branch: worktreePath === null ? null : `cw/${id}`,
    createdAt: over.createdAt ?? new Date().toISOString(), lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costBudgetUsd: null, costSpentUsd: 0,
    enforcementTier: 'T3', pid: null, launchArgs: null,
  });
  const methods = buildMethods(db, rootPath);
  const overview = async (): Promise<Overview> => (await methods['stats.overview']!({ workspaceId: 'ws_1' }, ctx)) as Overview;
  const untilMeasured = async (id: string): Promise<Overview> => {
    const end = Date.now() + 5000;
    for (;;) {
      const o = await overview();
      if (o.sessions.find((s) => s.id === id)?.diskBytes !== null) return o;
      if (Date.now() > end) throw new Error('never measured');
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  return { db, add, methods, overview, untilMeasured };
}

describe('stats.overview', () => {
  test('answers at once with null disk and starts the measuring; the next asks find the figure', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'cw-stats-wt-'));
    try {
      await writeFile(join(worktree, 'a.bin'), Buffer.alloc(4096));
      await writeFile(join(worktree, 'b.bin'), Buffer.alloc(1000));
      const t = setup('/tmp/w-stats');
      t.add('s_1', worktree);
      const first = await t.overview();
      const row = first.sessions.find((s) => s.id === 's_1')!;
      expect(row.diskBytes).toBeNull();
      expect(row.diskMeasuring).toBe(true);
      const done = await t.untilMeasured('s_1');
      expect(done.sessions.find((s) => s.id === 's_1')).toMatchObject({ diskBytes: 5096, diskMeasuring: false, diskApprox: false });
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test('a shared session (its worktree is the project folder) is never sized, and never "measuring"', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cw-stats-root-'));
    try {
      await writeFile(join(root, 'mine.bin'), Buffer.alloc(9999));
      const t = setup(root);
      t.add('s_shared', root);
      const o = await t.overview();
      expect(o.sessions[0]).toMatchObject({ shared: true, diskBytes: null, diskMeasuring: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a worktree that is gone is 0 bytes, not an error and not stuck measuring', async () => {
    const t = setup('/tmp/w-stats-2');
    t.add('s_gone', join(tmpdir(), 'cw-not-here-98765'));
    const o = await t.untilMeasured('s_gone');
    expect(o.sessions[0]).toMatchObject({ diskBytes: 0, diskMeasuring: false });
  });

  test('carries the daemon\'s own figures and the configured limits', async () => {
    const t = setup('/tmp/w-stats-3');
    const o = await t.overview();
    expect(o.process.pid).toBe(process.pid);
    expect(o.process.rssBytes).toBeGreaterThan(0);
    expect(o.process.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(o.terminals).toBe(0);
    expect(o.running).toBe(0);
    expect(o.limits).toEqual({ perSessionBytes: DEFAULT_CONFIG.disk.perSessionBytes, perWorkspaceBytes: DEFAULT_CONFIG.disk.perWorkspaceBytes });
    expect(o.sessions).toEqual([]);
  });

  test('sessions started and landed per day: today counts, an unreadable date is skipped, not fatal', async () => {
    const t = setup('/tmp/w-stats-4');
    const today = new Date().toISOString();
    t.add('s_today', null, { createdAt: today });
    t.add('s_broken', null, { createdAt: 'not a date' });
    new SessionHistoryRepo(t.db).record({
      id: 'h_1', workspaceId: 'ws_1', sessionId: 'old', name: 'old', agentKind: 'shell', branch: 'cw/old', finalStatus: 'landed',
      createdAt: today, endedAt: today, tokenSpent: 0, costSpentUsd: 0, note: null,
    });
    const o = await t.overview();
    const day = today.slice(0, 10);
    expect(o.startedPerDay[day]).toBeGreaterThanOrEqual(2); // the live session and the history row that started today
    expect(o.landedPerDay[day]).toBe(1);
    expect(Object.keys(o.startedPerDay).every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))).toBe(true);
  });

  test('an unknown workspace is a clean error, and a missing param is refused', async () => {
    const t = setup('/tmp/w-stats-5');
    expect(await codeOf(() => t.methods['stats.overview']!({ workspaceId: 'ws_nope' }, ctx))).toBe('WORKSPACE_NOT_FOUND');
    expect(await codeOf(() => t.methods['stats.overview']!({}, ctx))).toBe('INVALID_PARAMS');
  });
});
