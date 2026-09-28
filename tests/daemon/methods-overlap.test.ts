import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import type { MethodHandler } from '../../src/daemon/server.js';
import { WorkspaceManager } from '../../src/domain/workspace.js';
import { makeGitFixture } from '../helpers/git-fixture.js';

interface Row {
  id: string;
  name: string;
  worktreePath: string | null;
  overlaps?: { session: string; paths: string[] }[];
}

interface Fixture {
  methods: Record<string, MethodHandler>;
  workspaceId: string;
  cleanup: () => Promise<void>;
}

const ctx = { notify: () => undefined, onClose: () => undefined };

/** alice and bob in their own worktrees, both with an uncommitted `shared.ts`. */
async function twoOverlappingSessions(): Promise<Fixture> {
  const fx = await makeGitFixture();
  const db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
  const ws = new WorkspaceManager(db).init(fx.root);
  const methods = buildMethods(db, fx.root);
  const alice = (await methods['session.new']!({ workspaceId: ws.id, name: 'alice' }, ctx)) as Row;
  const bob = (await methods['session.new']!({ workspaceId: ws.id, name: 'bob' }, ctx)) as Row;
  for (const s of [alice, bob]) writeFileSync(join(s.worktreePath as string, 'shared.ts'), 'x');
  return {
    methods,
    workspaceId: ws.id,
    cleanup: async () => { db.close(); await fx.cleanup(); },
  };
}

/**
 * The overlap signal is read in the background (it must not block `session.list`), so
 * the shape reaches a client on a later redraw — the same as the git badge. The first
 * test polls until it lands; the on-demand paths below must answer in one call.
 */
describe('session.list overlap signal', () => {
  test('two worktree sessions on the same file name each other; a shared session takes no part', async () => {
    const fx = await makeGitFixture();
    const db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
    try {
      const ws = new WorkspaceManager(db).init(fx.root);
      const methods = buildMethods(db, fx.root);

      const alice = (await methods['session.new']!({ workspaceId: ws.id, name: 'alice' }, ctx)) as Row;
      const bob = (await methods['session.new']!({ workspaceId: ws.id, name: 'bob' }, ctx)) as Row;
      await methods['session.new']!({ workspaceId: ws.id, name: 'shared', worktree: false }, ctx);
      for (const s of [alice, bob]) writeFileSync(join(s.worktreePath as string, 'shared.ts'), 'x');

      const list = async (): Promise<Row[]> => (await methods['session.list']!({ workspaceId: ws.id }, ctx)) as Row[];
      const deadline = Date.now() + 5000;
      let rows = await list();
      while (!rows.some((r) => r.overlaps !== undefined) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
        rows = await list();
      }

      expect(rows.find((r) => r.name === 'alice')?.overlaps).toEqual([{ session: 'bob', paths: ['shared.ts'] }]);
      expect(rows.find((r) => r.name === 'bob')?.overlaps).toEqual([{ session: 'alice', paths: ['shared.ts'] }]);
      // The shared session works in the project folder: no branch of its own, no signal.
      expect(rows.find((r) => r.name === 'shared')?.overlaps).toBeUndefined();
    } finally {
      db.close();
      await fx.cleanup();
    }
  }, 15_000);

  test('overlap.list answers fresh in one call, each pair once', async () => {
    const fx = await twoOverlappingSessions();
    try {
      const { pairs } = (await fx.methods['overlap.list']!({ workspaceId: fx.workspaceId }, ctx)) as {
        pairs: { a: string; b: string; paths: string[] }[];
      };
      expect(pairs).toEqual([{ a: 'alice', b: 'bob', paths: ['shared.ts'] }]);
    } finally {
      await fx.cleanup();
    }
  }, 15_000);
});
