import { describe, expect, test } from 'bun:test';
import { formatOverlapPairs, overlapCommand } from '../../src/cli/commands/overlap.js';

describe('formatOverlapPairs', () => {
  test('one line per pair, tab-separated, paths joined in a stable order', () => {
    expect(formatOverlapPairs([
      { a: 'alice', b: 'bob', paths: ['a.ts', 'b.ts'] },
      { a: 'alice', b: 'carol', paths: ['c.ts'] },
    ])).toBe('alice <-> bob\ta.ts, b.ts\nalice <-> carol\tc.ts');
  });

  test('no pairs is an empty string', () => {
    expect(formatOverlapPairs([])).toBe('');
  });

  test('the command is exposed under the name `cw overlap`', () => {
    const meta = overlapCommand.meta as unknown as { name?: string } | undefined;
    expect(meta?.name).toBe('overlap');
  });
});
