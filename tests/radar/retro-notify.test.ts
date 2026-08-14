import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { FileClaimRepo } from '../../src/db/repositories/file-claim.js';
import { MessageBus } from '../../src/domain/bus.js';
import { SessionManager } from '../../src/domain/session.js';
import { NotificationGate } from '../../src/radar/noise.js';
import { notifyCollisions } from '../../src/radar/retro-notify.js';
import type { NotifyDispatcherDeps } from '../../src/notify/dispatcher.js';
import { BroadcastRegistry } from '../../src/daemon/broadcast.js';

function seed(db: ReturnType<typeof openDatabase>) {
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
}

describe('notifyCollisions', () => {
  test('a session with a divergent claim gets a system inbox message', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const claims = new FileClaimRepo(db);
    claims.upsert({
      id: 'fc_1', sessionId: 's_1', workspaceId: 'ws_1', path: 'src/x.ts', symbol: 'foo',
      kind: 'function', headSha: 'sha', bodyHash: 'h1', firstSeen: 'now', lastSeen: 'now',
    });
    claims.upsert({
      id: 'fc_2', sessionId: 's_2', workspaceId: 'ws_1', path: 'src/x.ts', symbol: 'foo',
      kind: 'function', headSha: 'sha', bodyHash: 'h2', firstSeen: 'now', lastSeen: 'now',
    });
    const bus = new MessageBus(db, new SessionManager(db));
    const notifyDeps: NotifyDispatcherDeps = { gate: new NotificationGate(), isEnabled: () => true, send: () => {} };

    notifyCollisions(claims, bus, new NotificationGate(), { workspaceId: 'ws_1', sessionId: 's_1' }, notifyDeps, new BroadcastRegistry());

    const inbox = bus.inbox('ws_1', 's_2');
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.trust).toBe('system');
    expect(inbox[0]?.body).toContain('src/x.ts');
  });

  test('the rate-limit gate suppresses a repeat call for the same collision', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const claims = new FileClaimRepo(db);
    claims.upsert({
      id: 'fc_1', sessionId: 's_1', workspaceId: 'ws_1', path: 'src/x.ts', symbol: 'foo',
      kind: 'function', headSha: 'sha', bodyHash: 'h1', firstSeen: 'now', lastSeen: 'now',
    });
    claims.upsert({
      id: 'fc_2', sessionId: 's_2', workspaceId: 'ws_1', path: 'src/x.ts', symbol: 'foo',
      kind: 'function', headSha: 'sha', bodyHash: 'h2', firstSeen: 'now', lastSeen: 'now',
    });
    const bus = new MessageBus(db, new SessionManager(db));
    const gate = new NotificationGate();
    const notifyDeps: NotifyDispatcherDeps = { gate, isEnabled: () => true, send: () => {} };

    const broadcastRegistry = new BroadcastRegistry();
    notifyCollisions(claims, bus, gate, { workspaceId: 'ws_1', sessionId: 's_1' }, notifyDeps, broadcastRegistry);
    notifyCollisions(claims, bus, gate, { workspaceId: 'ws_1', sessionId: 's_1' }, notifyDeps, broadcastRegistry);

    expect(bus.inbox('ws_1', 's_2')).toHaveLength(1);
  });

  test('a collision also fires a desktop notification, sharing the SAME gate the advisory message used', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const claims = new FileClaimRepo(db);
    claims.upsert({
      id: 'fc_1', sessionId: 's_1', workspaceId: 'ws_1', path: 'src/x.ts', symbol: 'foo',
      kind: 'function', headSha: 'sha', bodyHash: 'h1', firstSeen: 'now', lastSeen: 'now',
    });
    claims.upsert({
      id: 'fc_2', sessionId: 's_2', workspaceId: 'ws_1', path: 'src/x.ts', symbol: 'foo',
      kind: 'function', headSha: 'sha', bodyHash: 'h2', firstSeen: 'now', lastSeen: 'now',
    });
    const bus = new MessageBus(db, new SessionManager(db));
    const gate = new NotificationGate();
    const sent: string[] = [];
    const notifyDeps: NotifyDispatcherDeps = {
      gate, isEnabled: () => true,
      send: (_title, message) => { sent.push(message); },
    };

    notifyCollisions(claims, bus, gate, { workspaceId: 'ws_1', sessionId: 's_1' }, notifyDeps, new BroadcastRegistry());

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('src/x.ts');
    // The advisory bus message ALSO went out — proving both piggyback on the same
    // single gate.shouldNotify call, not two independent throttles.
    expect(bus.inbox('ws_1', 's_2')).toHaveLength(1);
  });

  test('a second call within the gate window sends neither the advisory message nor a second notification', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const claims = new FileClaimRepo(db);
    claims.upsert({
      id: 'fc_1', sessionId: 's_1', workspaceId: 'ws_1', path: 'src/x.ts', symbol: 'foo',
      kind: 'function', headSha: 'sha', bodyHash: 'h1', firstSeen: 'now', lastSeen: 'now',
    });
    claims.upsert({
      id: 'fc_2', sessionId: 's_2', workspaceId: 'ws_1', path: 'src/x.ts', symbol: 'foo',
      kind: 'function', headSha: 'sha', bodyHash: 'h2', firstSeen: 'now', lastSeen: 'now',
    });
    const bus = new MessageBus(db, new SessionManager(db));
    const gate = new NotificationGate();
    const sent: string[] = [];
    const notifyDeps: NotifyDispatcherDeps = { gate, isEnabled: () => true, send: (_t, m) => { sent.push(m); } };

    const broadcastRegistry = new BroadcastRegistry();
    notifyCollisions(claims, bus, gate, { workspaceId: 'ws_1', sessionId: 's_1' }, notifyDeps, broadcastRegistry);
    notifyCollisions(claims, bus, gate, { workspaceId: 'ws_1', sessionId: 's_1' }, notifyDeps, broadcastRegistry);

    expect(sent).toHaveLength(1);
    expect(bus.inbox('ws_1', 's_2')).toHaveLength(1);
  });
});
