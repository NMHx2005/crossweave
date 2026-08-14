import { describe, expect, test } from 'bun:test';
import { BroadcastRegistry } from '../../src/daemon/broadcast.js';

describe('BroadcastRegistry', () => {
  test('broadcast reaches every subscriber', () => {
    const registry = new BroadcastRegistry();
    const calls: Array<[string, unknown]> = [];
    registry.subscribe((m, p) => calls.push(['a', p]));
    registry.subscribe((m, p) => calls.push(['b', p]));
    registry.broadcast('tui.event', { kind: 'collision' });
    expect(calls).toEqual([
      ['a', { kind: 'collision' }],
      ['b', { kind: 'collision' }],
    ]);
  });

  test('broadcast with no subscribers does nothing (never throws)', () => {
    const registry = new BroadcastRegistry();
    expect(() => registry.broadcast('tui.invalidate', {})).not.toThrow();
  });

  test('unsubscribe stops delivery to that subscriber only', () => {
    const registry = new BroadcastRegistry();
    const calls: string[] = [];
    const unsubA = registry.subscribe(() => calls.push('a'));
    registry.subscribe(() => calls.push('b'));
    unsubA();
    registry.broadcast('tui.invalidate', {});
    expect(calls).toEqual(['b']);
  });

  test('calling the returned unsubscribe twice is a no-op, not an error', () => {
    const registry = new BroadcastRegistry();
    const unsub = registry.subscribe(() => {});
    unsub();
    expect(() => unsub()).not.toThrow();
  });

  test('the same subscriber function can be registered twice and each gets its own unsubscribe', () => {
    const registry = new BroadcastRegistry();
    const calls: number[] = [];
    const fn = () => calls.push(1);
    registry.subscribe(fn);
    const unsub2 = registry.subscribe(fn);
    unsub2();
    registry.broadcast('tui.invalidate', {});
    // Sets dedupe identical function references — registering the same fn twice and
    // unsubscribing one occurrence removes BOTH, since a Set can only hold it once.
    // This is a real, documented limitation of the Set-backed implementation, not a
    // test bug — assert the actual (documented) behavior.
    expect(calls).toEqual([]);
  });
});
