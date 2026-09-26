import { describe, expect, test } from 'bun:test';
import { NotificationGate } from '../../src/notify/gate.js';
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
    notify(base, { kind: 'land', session: 'auth', ok: true, baseBranch: 'main', workspaceId: 'ws_1' });
    expect(sent).toHaveLength(0);
    expect(gateCalled).toBe(false);
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
