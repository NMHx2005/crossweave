import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { WorkspaceManager } from '../../src/domain/workspace.js';
import { makeGitFixture } from '../helpers/git-fixture.js';

const codeOf = async (fn: () => unknown): Promise<string> => { try { await fn(); return 'ok'; } catch (e) { return (e as { code?: string }).code ?? 'no-code'; } };
const until = async (fn: () => Promise<boolean>): Promise<void> => { const end = Date.now() + 8000; while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 25)); } throw new Error('timed out'); };

describe('land.session with converge.requireCheck', () => {
  test('refuses a session without a fresh passing check, and lets a skip or a pass through', async () => {
    const fx = await makeGitFixture();
    const db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
    try {
      const ws = new WorkspaceManager(db).init(fx.root);
      const ctx = { notify: () => undefined, onClose: () => undefined };
      writeFileSync(join(fx.root, 'crossweave.config.json'), JSON.stringify({ converge: { testCommand: 'test -f ok.txt', requireCheck: true } }));
      const methods = buildMethods(db, fx.root);
      await methods['session.new']!({ workspaceId: ws.id, name: 'solo' }, ctx);
      // A land that gets past the gate reports through the desktop notifier; a test must not pop real notifications.
      await methods['config.setNotify']!({ workspaceId: ws.id, event: 'land', enabled: false }, ctx);
      const land =(extra: Record<string, unknown> = {}) => codeOf(() => methods['land.session']!({ workspaceId: ws.id, idOrName: 'solo', ...extra }, ctx));
      const listed = async () => ((await methods['session.list']!({ workspaceId: ws.id }, ctx)) as Array<Record<string, any>>).find((s) => s.name === 'solo')!;

      // Never checked.
      expect(await land()).toBe('CHECK_REQUIRED');

      // Checked and failed.
      await methods['config.trust']!({ workspaceId: ws.id }, ctx);
      await methods['session.check']!({ workspaceId: ws.id, idOrName: 'solo' }, ctx);
      await until(async () => (await listed()).check?.state === 'fail');
      expect(await land()).toBe('CHECK_REQUIRED');

      // The explicit skip is a different word from --force, which only stops a live session.
      expect(await land({ force: true })).toBe('CHECK_REQUIRED');
      expect(await land({ skipCheck: true })).not.toBe('CHECK_REQUIRED');
    } finally {
      db.close();
      await fx.cleanup();
    }
  }, 30_000);

  test('without the flag a missing check blocks nothing', async () => {
    const fx = await makeGitFixture();
    const db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
    try {
      const ws = new WorkspaceManager(db).init(fx.root);
      const ctx = { notify: () => undefined, onClose: () => undefined };
      const methods = buildMethods(db, fx.root);
      await methods['session.new']!({ workspaceId: ws.id, name: 'solo' }, ctx);
      await methods['config.setNotify']!({ workspaceId: ws.id, event: 'land', enabled: false }, ctx);
      expect(await codeOf(() => methods['land.session']!({ workspaceId: ws.id, idOrName: 'solo' }, ctx))).not.toBe('CHECK_REQUIRED');
    } finally {
      db.close();
      await fx.cleanup();
    }
  }, 30_000);
});

describe('session.check', () => {
  test('refuses without a command, refuses an untrusted one, then runs the trusted one in the session worktree', async () => {
    const fx = await makeGitFixture();
    const db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
    try {
      const ws = new WorkspaceManager(db).init(fx.root);
      const ctx = { notify: () => undefined, onClose: () => undefined };

      // No testCommand configured at all.
      let methods = buildMethods(db, fx.root);
      await methods['session.new']!({ workspaceId: ws.id, name: 'solo' }, ctx);
      expect(await codeOf(() => methods['session.check']!({ workspaceId: ws.id, idOrName: 'solo' }, ctx))).toBe('CHECK_NOT_CONFIGURED');

      // Configured but nobody trusted it: never run.
      // The marker records what the check saw; the path never goes through shell quoting.
      const command = 'test -f ok.txt && printf %s "$CW_WORKSPACE_ROOT" > root.txt';
      writeFileSync(join(fx.root, 'crossweave.config.json'), JSON.stringify({ converge: { testCommand: command } }));
      methods = buildMethods(db, fx.root);
      expect(await codeOf(() => methods['session.check']!({ workspaceId: ws.id, idOrName: 'solo' }, ctx))).toBe('CHECK_UNTRUSTED');

      await methods['config.trust']!({ workspaceId: ws.id }, ctx);
      const listed = async () => ((await methods['session.list']!({ workspaceId: ws.id }, ctx)) as Array<Record<string, any>>).find((s) => s.name === 'solo')!;
      expect((await listed()).check).toBeUndefined();

      // The worktree has no ok.txt: fail. Then add it: pass.
      await methods['session.check']!({ workspaceId: ws.id, idOrName: 'solo' }, ctx);
      await until(async () => (await listed()).check?.state === 'fail');
      expect((await listed()).check).toMatchObject({ state: 'fail', code: 1, stale: false });

      const worktree = (await listed()).worktreePath as string;
      writeFileSync(join(worktree, 'ok.txt'), 'x');
      await methods['session.check']!({ workspaceId: ws.id, idOrName: 'solo' }, ctx);
      await until(async () => (await listed()).check?.state === 'pass');
      // A new untracked file changed the count since the run began...
      expect((await listed()).check?.state).toBe('pass');
      expect(readFileSync(join(worktree, 'root.txt'), 'utf8')).toBe(fx.root);
    } finally {
      db.close();
      await fx.cleanup();
    }
  }, 30_000);
});
