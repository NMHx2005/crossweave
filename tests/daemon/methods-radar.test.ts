import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { FileClaimRepo } from '../../src/db/repositories/file-claim.js';

const ctx = { notify: () => undefined, onClose: () => undefined };

describe('radar.check RPC', () => {
  test('reports a collision written directly to file_claim', async () => {
    const db = openDatabase(':memory:');
    new WorkspaceRepo(db).insert({
      id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
      defaultIsolation: 'worktree', safeModeTier: 'T1',
    });
    const sessions = new SessionRepo(db);
    for (const id of ['s_1', 's_2']) {
      sessions.insert({
        id, workspaceId: 'ws_1', name: id, agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: `/tmp/w/${id}`, branch: `cw/${id}`, createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null, enforcementTier: 'T3', pid: null,
      });
    }
    new FileClaimRepo(db).upsert({
      id: 'fc_1', sessionId: 's_2', workspaceId: 'ws_1', path: 'src/x.ts', symbol: 'foo',
      kind: 'function', headSha: 'sha', bodyHash: 'h2', firstSeen: 'now', lastSeen: 'now',
    });

    const methods = buildMethods(db, '/tmp/w', undefined, undefined, { notifySend: () => {} });
    const result = (await methods['radar.check']!(
      { workspaceId: 'ws_1', sessionId: 's_1', path: 'src/x.ts', symbol: 'foo' },
      { notify: () => undefined, onClose: () => undefined },
    )) as { collisions: unknown[]; blocked: boolean };

    expect(result.collisions).toHaveLength(1);
    // s_1's own enforcementTier is T3 (an opaque adapter that cannot intercept
    // anything), so it can never be blocked no matter the workspace's Safe Mode.
    expect(result.blocked).toBe(false);
  });

  test('a blocked write fires a "blocked" desktop notification', async () => {
    const db = openDatabase(':memory:');
    new WorkspaceRepo(db).insert({
      id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
      defaultIsolation: 'worktree', safeModeTier: 'T2',
    });
    const sessions = new SessionRepo(db);
    for (const [id, tier] of [['s_1', 'T2'], ['s_2', 'T2']] as const) {
      sessions.insert({
        id, workspaceId: 'ws_1', name: id, agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: `/tmp/w/${id}`, branch: `cw/${id}`, createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null,
        enforcementTier: tier, pid: null,
      });
    }
    new FileClaimRepo(db).upsert({
      id: 'fc_1', sessionId: 's_2', workspaceId: 'ws_1', path: 'src/x.ts', symbol: 'foo',
      kind: 'function', headSha: 'sha', bodyHash: 'h2', firstSeen: 'now', lastSeen: 'now',
    });

    const sends: Array<[string, string]> = [];
    const methods = buildMethods(db, '/tmp/w', undefined, undefined, {
      notifySend: (title, message) => sends.push([title, message]),
    });
    const result = (await methods['radar.check']!(
      { workspaceId: 'ws_1', sessionId: 's_1', path: 'src/x.ts', symbol: 'foo' }, ctx,
    )) as { blocked: boolean };
    expect(result.blocked).toBe(true);
    // A real send() would try osascript/terminal-notifier here, which is
    // undesirable in a unit test — see the design doc §5 note on why
    // sendMacNotification is never exercised this way. `notifySend` (M6b final
    // review Finding 2) is the injectable seam that keeps this test honest.
    // The same file_claim also makes s_1's write collide with s_2's, so a
    // "collision" send fires too (Finding 1 gates it to exactly one) — this
    // test only asserts on the "blocked" send it's actually about.
    expect(sends.some(([title]) => title === 'crossweave — blocked')).toBe(true);
  });

  test('Finding 1 regression: 5 identical radar.check calls fire exactly 1 collision notification', async () => {
    const db = openDatabase(':memory:');
    new WorkspaceRepo(db).insert({
      id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
      defaultIsolation: 'worktree', safeModeTier: 'T1',
    });
    const sessions = new SessionRepo(db);
    for (const id of ['s_1', 's_2']) {
      sessions.insert({
        id, workspaceId: 'ws_1', name: id, agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: `/tmp/w/${id}`, branch: `cw/${id}`, createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null, enforcementTier: 'T3', pid: null,
      });
    }
    new FileClaimRepo(db).upsert({
      id: 'fc_1', sessionId: 's_2', workspaceId: 'ws_1', path: 'src/x.ts', symbol: 'foo',
      kind: 'function', headSha: 'sha', bodyHash: 'h2', firstSeen: 'now', lastSeen: 'now',
    });

    let collisionSends = 0;
    const methods = buildMethods(db, '/tmp/w', undefined, undefined, {
      notifySend: (title) => {
        if (title === 'crossweave') collisionSends += 1;
      },
    });

    for (let i = 0; i < 5; i += 1) {
      await methods['radar.check']!(
        { workspaceId: 'ws_1', sessionId: 's_1', path: 'src/x.ts', symbol: 'foo' }, ctx,
      );
    }

    // Before this fix, radar.check's live-hook collision loop never gated on
    // notifyGate at all — 5 identical calls fired 5 real sends, not 1.
    expect(collisionSends).toBe(1);
  });

  test('Finding 1 regression: the collision gate key is shared across callers, not per-querying-session', async () => {
    const db = openDatabase(':memory:');
    new WorkspaceRepo(db).insert({
      id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
      defaultIsolation: 'worktree', safeModeTier: 'T1',
    });
    const sessions = new SessionRepo(db);
    // s_1 and s_3 are two DIFFERENT querying sessions that both end up
    // discovering the same collision against s_2 — standing in for "live-hook
    // call" vs "background path" both reporting the same underlying collision.
    // buildMethods constructs the NotificationGate internally with no seam to
    // inject a fake instance here, so this file's existing scope can't wire the
    // real background path (RadarWatcherRegistry/notifyCollisions) directly;
    // per the brief, using two distinct callers against one collision target is
    // the honest proxy available within this file — the fix's gate key is
    // `(c.sessionId, c.path, c.symbol)`, which deliberately omits the querying
    // session, so it is exactly the mechanism that also makes the live-hook and
    // background paths share one budget in production.
    for (const id of ['s_1', 's_2', 's_3']) {
      sessions.insert({
        id, workspaceId: 'ws_1', name: id, agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: `/tmp/w/${id}`, branch: `cw/${id}`, createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null, enforcementTier: 'T3', pid: null,
      });
    }
    new FileClaimRepo(db).upsert({
      id: 'fc_1', sessionId: 's_2', workspaceId: 'ws_1', path: 'src/x.ts', symbol: 'foo',
      kind: 'function', headSha: 'sha', bodyHash: 'h2', firstSeen: 'now', lastSeen: 'now',
    });

    let collisionSends = 0;
    const methods = buildMethods(db, '/tmp/w', undefined, undefined, {
      notifySend: (title) => {
        if (title === 'crossweave') collisionSends += 1;
      },
    });

    await methods['radar.check']!(
      { workspaceId: 'ws_1', sessionId: 's_1', path: 'src/x.ts', symbol: 'foo' }, ctx,
    );
    await methods['radar.check']!(
      { workspaceId: 'ws_1', sessionId: 's_3', path: 'src/x.ts', symbol: 'foo' }, ctx,
    );

    expect(collisionSends).toBe(1);
  });

  test('a collision broadcasts tui.event to a subscribed connection', async () => {
    const db = openDatabase(':memory:');
    new WorkspaceRepo(db).insert({
      id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
      defaultIsolation: 'worktree', safeModeTier: 'T1',
    });
    const sessions = new SessionRepo(db);
    for (const id of ['s_1', 's_2']) {
      sessions.insert({
        id, workspaceId: 'ws_1', name: id, agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: `/tmp/w/${id}`, branch: `cw/${id}`, createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null, enforcementTier: 'T3', pid: null,
      });
    }
    new FileClaimRepo(db).upsert({
      id: 'fc_1', sessionId: 's_2', workspaceId: 'ws_1', path: 'src/x.ts', symbol: 'foo',
      kind: 'function', headSha: 'sha', bodyHash: 'h2', firstSeen: 'now', lastSeen: 'now',
    });

    const methods = buildMethods(db, '/tmp/w', undefined, undefined, { notifySend: () => {} });
    const broadcasts: Array<[string, unknown]> = [];
    const subscriberCtx = { notify: (m: string, p: unknown) => broadcasts.push([m, p]), onClose: () => undefined };
    await methods['daemon.subscribe']!({}, subscriberCtx);

    await methods['radar.check']!(
      { workspaceId: 'ws_1', sessionId: 's_1', path: 'src/x.ts', symbol: 'foo' },
      ctx,
    );

    const tuiEvents = broadcasts.filter(([m]) => m === 'tui.event');
    expect(tuiEvents).toHaveLength(1);
    expect((tuiEvents[0]![1] as { kind: string }).kind).toBe('collision');
  });
});
