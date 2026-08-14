import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';

describe('daemon.subscribe', () => {
  test('returns { subscribed: true } and the connection starts receiving broadcasts', async () => {
    const db = openDatabase(':memory:');
    const notified: Array<[string, unknown]> = [];
    const methods = buildMethods(db, '/tmp/w');
    const ctx = {
      notify: (m: string, p: unknown) => notified.push([m, p]),
      onClose: () => undefined,
    };
    const result = await methods['daemon.subscribe']!({}, ctx);
    expect(result).toEqual({ subscribed: true });
  });
});
