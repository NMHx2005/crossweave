import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { MergeTrialRepo } from '../../src/db/repositories/merge-trial.js';

describe('converge.status RPC', () => {
  test('reports the pairwise matrix and recommended order from seeded trial data', async () => {
    const db = openDatabase(':memory:');
    new WorkspaceRepo(db).insert({
      id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
      defaultIsolation: 'worktree', safeModeTier: 'T1',
    });
    const sessions = new SessionRepo(db);
    // worktreePath must point at a directory that actually exists — buildMethods'
    // boot-time reconcile() marks any `running`/`waiting` session whose worktree is
    // gone as `dead`, which converge.status's active-session filter then excludes.
    sessions.insert({
      id: 's_a', workspaceId: 'ws_1', name: 'a', agentKind: 'claude', adapter: 'claude',
      status: 'running', worktreePath: tmpdir(), branch: 'cw/a', createdAt: 'now',
      lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
    });
    sessions.insert({
      id: 's_b', workspaceId: 'ws_1', name: 'b', agentKind: 'claude', adapter: 'claude',
      status: 'running', worktreePath: tmpdir(), branch: 'cw/b', createdAt: 'now',
      lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
    });
    new MergeTrialRepo(db).insert({
      id: 'mt_1', workspaceId: 'ws_1', ts: 'now', branches: ['cw/a', 'cw/b'], result: 'conflict', detail: 'x.ts',
    });

    const methods = buildMethods(db, '/tmp/w');
    const result = (await methods['converge.status']!(
      { workspaceId: 'ws_1' },
      { notify: () => undefined, onClose: () => undefined },
    )) as { pairwise: unknown[]; recommendedOrder: string[]; degraded: boolean };

    expect(result.pairwise).toHaveLength(1);
    expect(result.recommendedOrder).toEqual(['a', 'b']);
    expect(result.degraded).toBe(false);
  });

  test('reports degraded once active sessions exceed converge.pairwiseSessionThreshold', async () => {
    const db = openDatabase(':memory:');
    new WorkspaceRepo(db).insert({
      id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
      defaultIsolation: 'worktree', safeModeTier: 'T1',
    });
    const sessions = new SessionRepo(db);
    // DEFAULT_CONFIG.converge.pairwiseSessionThreshold is 8 — 9 active sessions crosses it.
    for (let i = 0; i < 9; i += 1) {
      sessions.insert({
        id: `s_${i}`, workspaceId: 'ws_1', name: `s${i}`, agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: tmpdir(), branch: `cw/s${i}`, createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
      });
    }

    const methods = buildMethods(db, '/tmp/w');
    const result = (await methods['converge.status']!(
      { workspaceId: 'ws_1' },
      { notify: () => undefined, onClose: () => undefined },
    )) as { degraded: boolean };

    expect(result.degraded).toBe(true);
  });

  // Important 1: `recommendedOrder` is an ordering of every ACTIVE session,
  // conflicts and all — it is not a filter. `cw land all` needs the actual
  // conflict-free subset so it lands what it safely can instead of halting the
  // whole batch on a session that was never going to land cleanly.
  test('conflictFree excludes every session with a known conflict, unlike recommendedOrder', async () => {
    const db = openDatabase(':memory:');
    new WorkspaceRepo(db).insert({
      id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
      defaultIsolation: 'worktree', safeModeTier: 'T1',
    });
    const sessions = new SessionRepo(db);
    // A and B conflict with EACH OTHER (both would merge cleanly against base
    // individually — the conflict is pairwise, not "against base"). C conflicts
    // with nothing.
    for (const [id, branch, createdAt] of [
      ['s_a', 'cw/a', '2026-01-01T00:00:01.000Z'],
      ['s_b', 'cw/b', '2026-01-01T00:00:02.000Z'],
      ['s_c', 'cw/c', '2026-01-01T00:00:03.000Z'],
    ] as const) {
      sessions.insert({
        id, workspaceId: 'ws_1', name: id.slice(2), agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: tmpdir(), branch, createdAt,
        lastActiveAt: createdAt, tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
      });
    }
    new MergeTrialRepo(db).insert({
      id: 'mt_1', workspaceId: 'ws_1', ts: 'now', branches: ['cw/a', 'cw/b'], result: 'conflict', detail: 'x.ts',
    });

    const methods = buildMethods(db, '/tmp/w');
    const result = (await methods['converge.status']!(
      { workspaceId: 'ws_1' },
      { notify: () => undefined, onClose: () => undefined },
    )) as { recommendedOrder: string[]; conflictFree: string[] };

    expect(result.recommendedOrder).toContain('a');
    expect(result.recommendedOrder).toContain('b');
    expect(result.recommendedOrder).toContain('c');
    expect(result.conflictFree).toEqual(['c']);
    expect(result.conflictFree).not.toContain('a');
    expect(result.conflictFree).not.toContain('b');
  });
});
