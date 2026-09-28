import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { ConfigTrustRepo } from '../../src/db/repositories/config-trust.js';
import { SessionSetupRepo } from '../../src/db/repositories/session-setup.js';
import { WorkspaceManager } from '../../src/domain/workspace.js';
import { hashHooks } from '../../src/convergence/trust.js';
import type { AgentAdapter } from '../../src/adapters/types.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { makeGitFixture } from '../helpers/git-fixture.js';

const ctx = { notify: () => undefined, onClose: () => undefined };

function recordingAdapter(): { adapter: AgentAdapter; typed: string[] } {
  const typed: string[] = [];
  const adapter: AgentAdapter = {
    kind: 'shell',
    enforcementTier: 'T3',
    spawn: () => ({
      pid: 1,
      onData: () => undefined,
      onExit: () => undefined,
      write: (data: string) => { typed.push(data); },
      resize: () => undefined,
      kill: () => undefined,
    }),
  };
  return { adapter, typed };
}

const hooks = { sessionSetup: 'bun install' };
const config = { ...DEFAULT_CONFIG, hooks };

describe('session.setup RPC', () => {
  test('types the hook into an open shell, and refuses without a trust or a hook', async () => {
    const fx = await makeGitFixture();
    const db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
    try {
      const ws = new WorkspaceManager(db).init(fx.root);
      const { adapter, typed } = recordingAdapter();
      const methods = buildMethods(db, fx.root, () => adapter, config);
      const row = (await methods['session.new']!({ workspaceId: ws.id, name: 'a' }, ctx)) as { id: string };

      // Untrusted: refused, not run.
      let refused: string | undefined;
      try {
        await methods['session.setup']!({ workspaceId: ws.id, idOrName: 'a' }, ctx);
      } catch (err) {
        refused = (err as { code?: string }).code;
      }
      expect(refused).toBe('HOOKS_UNTRUSTED');

      new ConfigTrustRepo(db).setHooks(ws.id, hashHooks(hooks), 'now');
      await methods['session.start']!({ workspaceId: ws.id, idOrName: 'a' }, ctx);
      typed.length = 0; // drop the first-start typing; this is the re-run

      const setup = (await methods['session.setup']!({ workspaceId: ws.id, idOrName: 'a' }, ctx)) as { typed: boolean };
      expect(setup.typed).toBe(true);
      expect(typed).toEqual(['bun install\r']);
      expect(new SessionSetupRepo(db).has(row.id)).toBe(true);
    } finally {
      db.close();
      await fx.cleanup();
    }
  }, 15_000);

  test('refuses when no hook is configured', async () => {
    const fx = await makeGitFixture();
    const db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
    try {
      const ws = new WorkspaceManager(db).init(fx.root);
      const methods = buildMethods(db, fx.root);
      await methods['session.new']!({ workspaceId: ws.id, name: 'a' }, ctx);
      let refused: string | undefined;
      try {
        await methods['session.setup']!({ workspaceId: ws.id, idOrName: 'a' }, ctx);
      } catch (err) {
        refused = (err as { code?: string }).code;
      }
      expect(refused).toBe('CONFIG_NO_HOOKS');
    } finally {
      db.close();
      await fx.cleanup();
    }
  }, 15_000);
});

describe('session.list pending setup', () => {
  test('a worktree session with a trusted, unrun hook shows setup: pending, then stops', async () => {
    const fx = await makeGitFixture();
    const db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
    try {
      const ws = new WorkspaceManager(db).init(fx.root);
      new ConfigTrustRepo(db).setHooks(ws.id, hashHooks(hooks), 'now');
      const { adapter } = recordingAdapter();
      const methods = buildMethods(db, fx.root, () => adapter, config);
      await methods['session.new']!({ workspaceId: ws.id, name: 'a' }, ctx);

      const rows = async (): Promise<Array<{ name: string; setup?: string }>> =>
        (await methods['session.list']!({ workspaceId: ws.id }, ctx)) as Array<{ name: string; setup?: string }>;
      expect((await rows()).find((r) => r.name === 'a')?.setup).toBe('pending');

      await methods['session.start']!({ workspaceId: ws.id, idOrName: 'a' }, ctx);
      expect((await rows()).find((r) => r.name === 'a')?.setup).toBeUndefined();
    } finally {
      db.close();
      await fx.cleanup();
    }
  }, 15_000);
});
