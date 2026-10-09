import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { WorkspaceManager } from '../../src/domain/workspace.js';
import { makeGitFixture } from '../helpers/git-fixture.js';

const codeOf = async (fn: () => unknown): Promise<string> => { try { await fn(); return 'ok'; } catch (e) { return (e as { code?: string }).code ?? 'no-code'; } };

async function setup() {
  const fx = await makeGitFixture();
  const db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
  const ws = new WorkspaceManager(db).init(fx.root);
  const ctx = { notify: () => undefined, onClose: () => undefined };
  const methods = buildMethods(db, fx.root);
  const call = (m: string, p: Record<string, unknown> = {}): Promise<any> => methods[m]!({ workspaceId: ws.id, ...p }, ctx) as Promise<any>;
  return { fx, call, cleanup: async () => { db.close(); await fx.cleanup(); } };
}

describe('checkpoint RPCs', () => {
  test('take, list, diff and a dry-run then applied restore round-trip over the RPC shapes', async () => {
    const t = await setup();
    try {
      const row = await t.call('session.new', { name: 'dev' }) as { worktreePath: string };
      writeFileSync(join(row.worktreePath, 'README.md'), 'one\n');
      const first = await t.call('checkpoint.take', { idOrName: 'dev', label: 'start' });
      expect(first.seq).toBe(1);
      expect((await t.call('checkpoint.take', { idOrName: 'dev' })).unchanged).toBe(true);

      writeFileSync(join(row.worktreePath, 'README.md'), 'two\n');
      const list = await t.call('checkpoint.list', { idOrName: 'dev' });
      expect(list.checkpoints.map((c: { seq: number }) => c.seq)).toEqual([1]);

      const diff = await t.call('checkpoint.diff', { idOrName: 'dev', from: 1 });
      expect(diff.files.map((f: { path: string }) => f.path)).toEqual(['README.md']);

      const preview = await t.call('checkpoint.restore', { idOrName: 'dev', seq: 1 });
      expect(preview).toEqual({ plan: { write: ['README.md'], delete: [] }, applied: false });
      const done = await t.call('checkpoint.restore', { idOrName: 'dev', seq: 1, apply: true });
      expect(done.applied).toBe(true);
      expect(typeof done.preRestoreSeq).toBe('number');
    } finally { await t.cleanup(); }
  }, 30_000);

  test('a session in the project folder has no worktree to checkpoint', async () => {
    const t = await setup();
    try {
      await t.call('session.new', { name: 'shared', worktree: false });
      expect(await codeOf(() => t.call('checkpoint.take', { idOrName: 'shared' }))).toBe('CHECKPOINT_NO_WORKTREE');
    } finally { await t.cleanup(); }
  }, 30_000);

  test('bad params are refused, not run', async () => {
    const t = await setup();
    try {
      await t.call('session.new', { name: 'dev' });
      expect(await codeOf(() => t.call('checkpoint.restore', { idOrName: 'dev' }))).toBe('INVALID_PARAMS');
      expect(await codeOf(() => t.call('checkpoint.restore', { idOrName: 'dev', seq: 7, apply: true }))).toBe('CHECKPOINT_NOT_FOUND');
    } finally { await t.cleanup(); }
  }, 30_000);

  test('removing the session removes its checkpoints', async () => {
    const t = await setup();
    try {
      const row = await t.call('session.new', { name: 'dev' }) as { worktreePath: string };
      writeFileSync(join(row.worktreePath, 'README.md'), 'one\n');
      await t.call('checkpoint.take', { idOrName: 'dev' });
      expect((await $`git for-each-ref refs/crossweave`.cwd(t.fx.root).quiet().text()).trim()).not.toBe('');
      await t.call('session.kill', { idOrName: 'dev', removeWorktree: true });
      expect((await $`git for-each-ref refs/crossweave`.cwd(t.fx.root).quiet().text()).trim()).toBe('');
    } finally { await t.cleanup(); }
  }, 30_000);
});
