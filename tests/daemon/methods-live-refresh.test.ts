import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { WorkspaceManager } from '../../src/domain/workspace.js';
import { argvAdapter } from '../helpers/argv-adapter.js';
import { makeGitFixture } from '../helpers/git-fixture.js';

/**
 * Every client (cockpit, TUI, web) redraws on `tui.invalidate`. A session started by
 * ANOTHER client, or an agent that exits on its own, used to broadcast nothing: a
 * cockpit kept showing `stopped` for a session the CLI had just started, and would
 * keep showing `running` for an agent that had exited.
 */
describe('session lifecycle changes reach every client', () => {
  test('start and a self-exit each broadcast tui.invalidate', async () => {
    const fx = await makeGitFixture();
    const db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
    try {
      const ws = new WorkspaceManager(db).init(fx.root);
      // Stays up briefly, then exits by itself — no stop/kill from anyone.
      const methods = buildMethods(db, fx.root, () => argvAdapter(['sh', '-c', 'sleep 0.4']));
      const ctx = { notify: () => undefined, onClose: () => undefined };
      await methods['session.new']!({ workspaceId: ws.id, name: 'solo', agent: 'claude' }, ctx);

      const seen: string[] = [];
      await methods['daemon.subscribe']!({}, { notify: (m: string) => seen.push(m), onClose: () => undefined });

      await methods['session.start']!({ workspaceId: ws.id, idOrName: 'solo' }, ctx);
      expect(seen.filter((m) => m === 'tui.invalidate')).toHaveLength(1);

      const deadline = Date.now() + 5000;
      while (seen.filter((m) => m === 'tui.invalidate').length < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(seen.filter((m) => m === 'tui.invalidate')).toHaveLength(2);
    } finally {
      db.close();
      await fx.cleanup();
    }
  }, 15_000);
});
