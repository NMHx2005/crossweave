import { describe, expect, test } from 'bun:test';
import { NotificationGate } from '../../src/radar/noise.js';
import { notify, type NotifyEvent, type NotifyDispatcherDeps } from '../../src/notify/dispatcher.js';

interface Sent { title: string; message: string; clickCommand: string[] | undefined }

function deps(overrides: Partial<NotifyDispatcherDeps> = {}): { deps: NotifyDispatcherDeps; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    deps: {
      gate: new NotificationGate(),
      isEnabled: () => true,
      send: (title, message, clickCommand) => { sent.push({ title, message, clickCommand }); },
      ...overrides,
    },
  };
}

describe('notify', () => {
  test('collision: title/message name both sessions, path and symbol; click attaches to sessionB', () => {
    const { deps: d, sent } = deps();
    const event: NotifyEvent = {
      kind: 'collision', sessionA: 'auth', sessionB: 'payments',
      path: 'src/user.ts', symbol: 'User', workspaceId: 'ws_1',
    };
    notify(d, event);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.message).toContain('auth');
    expect(sent[0]!.message).toContain('payments');
    expect(sent[0]!.message).toContain('src/user.ts');
    expect(sent[0]!.message).toContain('User');
    expect(sent[0]!.clickCommand).toEqual(['cw', 'session', 'attach', 'payments']);
  });

  test('collision: null symbol renders without a dangling separator', () => {
    const { deps: d, sent } = deps();
    notify(d, { kind: 'collision', sessionA: 'a', sessionB: 'b', path: 'x.ts', symbol: null, workspaceId: 'ws_1' });
    expect(sent[0]!.message).not.toContain('null');
    expect(sent[0]!.message).toContain('x.ts');
  });

  test('blocked: names the session and path; click attaches to it', () => {
    const { deps: d, sent } = deps();
    notify(d, { kind: 'blocked', session: 'auth', path: 'src/user.ts', symbol: 'User', workspaceId: 'ws_1' });
    expect(sent[0]!.title).toContain('blocked');
    expect(sent[0]!.message).toContain('auth');
    expect(sent[0]!.message).toContain('src/user.ts');
    expect(sent[0]!.clickCommand).toEqual(['cw', 'session', 'attach', 'auth']);
  });

  test('land ok: names the session and base branch; click lists sessions (no single attach target)', () => {
    const { deps: d, sent } = deps();
    notify(d, { kind: 'land', session: 'auth', ok: true, baseBranch: 'main', workspaceId: 'ws_1' });
    expect(sent[0]!.title).toContain('land');
    expect(sent[0]!.message).toContain('auth');
    expect(sent[0]!.message).toContain('main');
    expect(sent[0]!.clickCommand).toEqual(['cw', 'session', 'list']);
  });

  test('land failure: names the session and reason', () => {
    const { deps: d, sent } = deps();
    notify(d, { kind: 'land', session: 'auth', ok: false, reason: 'LAND_CONFLICT', workspaceId: 'ws_1' });
    expect(sent[0]!.title).toContain('failed');
    expect(sent[0]!.message).toContain('auth');
    expect(sent[0]!.message).toContain('LAND_CONFLICT');
  });

  test('convergence: names both sessions and the state transition', () => {
    const { deps: d, sent } = deps();
    notify(d, { kind: 'convergence', sessionA: 'auth', sessionB: 'payments', from: 'clean', to: 'conflict', workspaceId: 'ws_1' });
    expect(sent[0]!.message).toContain('auth');
    expect(sent[0]!.message).toContain('payments');
    expect(sent[0]!.message).toContain('clean');
    expect(sent[0]!.message).toContain('conflict');
    expect(sent[0]!.clickCommand).toEqual(['cw', 'session', 'list']);
  });

  test('isEnabled(false) for this event: nothing is sent, gate is never consulted', () => {
    let gateCalled = false;
    const gate = new NotificationGate();
    const originalShouldNotify = gate.shouldNotify.bind(gate);
    gate.shouldNotify = (...args) => { gateCalled = true; return originalShouldNotify(...args); };
    const { deps: base, sent } = deps({ gate, isEnabled: () => false });
    notify(base, { kind: 'blocked', session: 'auth', path: 'x.ts', symbol: null, workspaceId: 'ws_1' });
    expect(sent).toHaveLength(0);
    expect(gateCalled).toBe(false);
  });

  test('collision does NOT consult the gate a second time — always sends when isEnabled is true', () => {
    // Per design doc §3.1: the caller (background watcher path) already gated once
    // before deciding to call notify() at all; notify() must not gate collision a
    // second time under a different key, or it would silently halve the advisory
    // budget the moment M6b ships.
    const gate = new NotificationGate();
    gate.shouldNotify('auth', 'x.ts', null); // consume the one slot for this triple
    const { deps: d, sent } = deps({ gate });
    notify(d, { kind: 'collision', sessionA: 'a', sessionB: 'auth', path: 'x.ts', symbol: null, workspaceId: 'ws_1' });
    expect(sent).toHaveLength(1); // still sends — collision never re-checks the gate
  });

  test('blocked DOES consult the gate — a repeat block on the same session/path/symbol is throttled', () => {
    const gate = new NotificationGate();
    const { deps: d, sent } = deps({ gate });
    const event: NotifyEvent = { kind: 'blocked', session: 'auth', path: 'x.ts', symbol: 'foo', workspaceId: 'ws_1' };
    notify(d, event);
    notify(d, event);
    expect(sent).toHaveLength(1);
  });

  test('land DOES consult the gate, keyed by session, not by path — a second land attempt is throttled', () => {
    const gate = new NotificationGate();
    const { deps: d, sent } = deps({ gate });
    notify(d, { kind: 'land', session: 'auth', ok: true, baseBranch: 'main', workspaceId: 'ws_1' });
    notify(d, { kind: 'land', session: 'auth', ok: false, reason: 'x', workspaceId: 'ws_1' });
    expect(sent).toHaveLength(1);
  });

  test('convergence DOES consult the gate, keyed by the sorted session pair — order does not matter', () => {
    const gate = new NotificationGate();
    const { deps: d, sent } = deps({ gate });
    notify(d, { kind: 'convergence', sessionA: 'a', sessionB: 'b', from: 'clean', to: 'conflict', workspaceId: 'ws_1' });
    notify(d, { kind: 'convergence', sessionA: 'b', sessionB: 'a', from: 'conflict', to: 'test_fail', workspaceId: 'ws_1' });
    expect(sent).toHaveLength(1);
  });

  test('a send() that throws is caught, logged once, never propagates', () => {
    const { deps: base } = deps({ send: () => { throw new Error('boom'); } });
    expect(() => notify(base, { kind: 'land', session: 'auth', ok: true, baseBranch: 'main', workspaceId: 'ws_1' })).not.toThrow();
  });
});
