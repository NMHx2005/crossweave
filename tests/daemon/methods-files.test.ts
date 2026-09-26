import { describe, expect, test } from 'bun:test';
import { writeFileSync, utimesSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { WorkspaceManager } from '../../src/domain/workspace.js';
import { ALLOWED_METHODS } from '../../src/gateway/gateway.js';
import { makeGitFixture } from '../helpers/git-fixture.js';

async function setup() {
  const fx = await makeGitFixture();
  const db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
  const ws = new WorkspaceManager(db).init(fx.root);
  const methods = buildMethods(db, fx.root);
  const ctx = { notify: () => undefined, onClose: () => undefined };
  const call = async (m: string, p: Record<string, unknown> = {}): Promise<unknown> => methods[m]!({ workspaceId: ws.id, ...p }, ctx);
  return { fx, db, call, cleanup: async () => { db.close(); await fx.cleanup(); } };
}

describe('file RPCs', () => {
  test('list, read and write a file in a session\'s worktree; a stale save is refused', async () => {
    const t = await setup();
    try {
      const row = await t.call('session.new', { name: 'ed', agent: 'claude' }) as { worktreePath: string };
      writeFileSync(join(row.worktreePath, 'notes.md'), '# hi\n');
      expect(await t.call('file.list', { idOrName: 'ed' })).toContain('notes.md');
      const read = await t.call('file.read', { idOrName: 'ed', path: 'notes.md' }) as { content: string; mtimeMs: number };
      expect(read.content).toBe('# hi\n');
      await t.call('file.write', { idOrName: 'ed', path: 'notes.md', content: '# edited\n', expectedMtimeMs: read.mtimeMs });

      // The agent writes the file behind the editor's back.
      const later = new Date(statSync(join(row.worktreePath, 'notes.md')).mtimeMs + 5000);
      writeFileSync(join(row.worktreePath, 'notes.md'), '# agent\n');
      utimesSync(join(row.worktreePath, 'notes.md'), later, later);
      await expect(t.call('file.write', { idOrName: 'ed', path: 'notes.md', content: 'mine', expectedMtimeMs: read.mtimeMs }))
        .rejects.toMatchObject({ code: 'FILE_CHANGED' });
      await expect(t.call('file.read', { idOrName: 'ed', path: '../../../etc/hosts' })).rejects.toMatchObject({ code: 'PATH_ESCAPE' });
    } finally {
      await t.cleanup();
    }
  }, 20_000);

  test('a new session can start from another branch', async () => {
    const t = await setup();
    try {
      await $`git branch release`.cwd(t.fx.root).quiet();
      await $`git checkout -q release`.cwd(t.fx.root).quiet();
      await $`git commit -q --allow-empty -m release-only`.cwd(t.fx.root).quiet();
      const tip = (await $`git rev-parse release`.cwd(t.fx.root).quiet().text()).trim();
      await $`git checkout -q main`.cwd(t.fx.root).quiet();
      expect(await t.call('git.branches')).toContain('release');
      const row = await t.call('session.new', { name: 'rel', agent: 'claude', base: 'release' }) as { worktreePath: string };
      expect((await $`git rev-parse HEAD`.cwd(row.worktreePath).quiet().text()).trim()).toBe(tip);
    } finally {
      await t.cleanup();
    }
  }, 20_000);

  test('none of it is reachable through the gateway', () => {
    for (const m of ['file.read', 'file.write', 'file.list', 'git.branches']) expect(ALLOWED_METHODS.has(m)).toBe(false);
  });
});
