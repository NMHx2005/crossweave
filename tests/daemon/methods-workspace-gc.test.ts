import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { makeGitFixture } from '../helpers/git-fixture.js';

/**
 * Regression guard for Important 2 (final-review fix wave): Task 2 wired
 * `tui.invalidate` at `session.new`/`session.kill`/`session.stop`/`session.rm`/
 * `land.session`, but Task 7's later `g` → `workspace.gc` binding never got the
 * same broadcast — so after a real `cw gc`/TUI `g`, the dashboard's panes went
 * stale (a selected session `collectGarbage` already deleted then fails
 * `SESSION_NOT_FOUND` on the next `l`/`x`/Enter). Mirrors the same
 * subscribe-then-assert pattern already used for `land.session` in
 * tests/convergence/land.test.ts.
 *
 * `collectGarbage`'s `sweepOrphans` shells out to real git (`git worktree list`),
 * so this needs a real git repo as the workspace root, not a fake path — same
 * reason tests/domain/gc.test.ts and tests/convergence/land.test.ts use
 * `makeGitFixture`.
 */
describe('workspace.gc RPC', () => {
  test('broadcasts tui.invalidate to a subscribed connection after a successful gc', async () => {
    const fixture = await makeGitFixture();
    try {
      const db = openDatabase(':memory:');
      new WorkspaceRepo(db).insert({
        id: 'ws_1', name: 'w', rootPath: fixture.root, createdAt: 'now',
        defaultIsolation: 'worktree', safeModeTier: 'T1',
      });
      const methods = buildMethods(db, fixture.root);
      const ctx = { notify: () => undefined, onClose: () => undefined };

      const broadcasts: Array<[string, unknown]> = [];
      const subscriberCtx = { notify: (m: string, p: unknown) => broadcasts.push([m, p]), onClose: () => undefined };
      await methods['daemon.subscribe']!({}, subscriberCtx);

      await methods['workspace.gc']!({ id: 'ws_1' }, ctx);

      const invalidations = broadcasts.filter(([m]) => m === 'tui.invalidate');
      expect(invalidations).toHaveLength(1);
      expect(invalidations[0]![1]).toEqual({});
    } finally {
      await fixture.cleanup();
    }
  });
});
