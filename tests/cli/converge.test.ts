import { describe, expect, test } from 'bun:test';
import { printOverlaps } from '../../src/cli/commands/converge.js';

describe('printOverlaps', () => {
  test('prints the section when the daemon answers', async () => {
    const out: string[] = [];
    await printOverlaps(
      async () => ({ pairs: [{ a: 'alice', b: 'bob', paths: ['x.ts'] }] }),
      'ws',
      (text) => out.push(text),
    );
    expect(out.join('')).toBe('overlaps:\n  alice <-> bob\tx.ts\n');
  });

  test('no overlaps prints nothing', async () => {
    const out: string[] = [];
    await printOverlaps(async () => ({ pairs: [] }), 'ws', (text) => out.push(text));
    expect(out).toEqual([]);
  });

  test('a daemon too old to answer overlap.list does not throw, and prints nothing', async () => {
    const out: string[] = [];
    await printOverlaps(
      async () => { throw new Error('Unknown method: overlap.list'); },
      'ws',
      (text) => out.push(text),
    );
    expect(out).toEqual([]);
  });
});
