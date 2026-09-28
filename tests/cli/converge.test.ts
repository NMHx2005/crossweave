import { describe, expect, test } from 'bun:test';
import { printOverlaps } from '../../src/cli/commands/converge.js';
import { CrossweaveError } from '../../src/core/errors.js';

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

  // The real DaemonClient rejects an unknown method with a CrossweaveError coded
  // METHOD_NOT_FOUND (see src/client/rpc-client.ts) — that is the only case this
  // tolerates. A plain Error, as an older, weaker version of this test threw, isn't
  // what a real old daemon produces and let a bare `catch {}` hide behind it.
  test('a daemon too old to answer overlap.list (METHOD_NOT_FOUND) does not throw, and prints nothing', async () => {
    const out: string[] = [];
    await printOverlaps(
      async () => { throw new CrossweaveError('METHOD_NOT_FOUND', 'Unknown method: overlap.list'); },
      'ws',
      (text) => out.push(text),
    );
    expect(out).toEqual([]);
  });

  // Regression: a genuine failure inside overlap.list (a bad git read, an internal
  // daemon exception, a transient socket error) must still reach the user, not be
  // hidden behind the same tolerance meant only for an old daemon.
  test('any other error from overlap.list propagates instead of being swallowed', async () => {
    await expect(
      printOverlaps(
        async () => { throw new CrossweaveError('RPC_ERROR', 'boom'); },
        'ws',
        () => {},
      ),
    ).rejects.toMatchObject({ code: 'RPC_ERROR' });
  });
});
