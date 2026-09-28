import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { ConfigTrustRepo } from '../../src/db/repositories/config-trust.js';
import { SessionSetupRepo } from '../../src/db/repositories/session-setup.js';
import { WorkspaceManager } from '../../src/domain/workspace.js';
import { hashHooks } from '../../src/convergence/trust.js';
import { wrapWithSentinel } from '../../src/domain/session-setup.js';
import type { AgentAdapter } from '../../src/adapters/types.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { makeGitFixture } from '../helpers/git-fixture.js';

const ctx = { notify: () => undefined, onClose: () => undefined };

/** A session process whose `write` is recorded — what the daemon types into the shell. */
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

/** Like `recordingAdapter`, but lets the test play back pty output — a fake shell echo. */
function scriptableAdapter(): { adapter: AgentAdapter; emit: (chunk: string) => void } {
  let onData: (chunk: string) => void = () => undefined;
  const adapter: AgentAdapter = {
    kind: 'shell',
    enforcementTier: 'T3',
    spawn: () => ({
      pid: 1,
      onData: (cb) => { onData = cb; },
      onExit: () => undefined,
      write: () => undefined,
      resize: () => undefined,
      kill: () => undefined,
    }),
  };
  return { adapter, emit: (chunk) => onData(chunk) };
}

const hooks = { sessionSetup: 'bun install' };
const config = { ...DEFAULT_CONFIG, hooks };

describe('session setup hook wiring', () => {
  test('untrusted: the notice is typed (and runs nothing), then the launch line', async () => {
    const fx = await makeGitFixture();
    const db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
    try {
      const ws = new WorkspaceManager(db).init(fx.root);
      const { adapter, typed } = recordingAdapter();
      const methods = buildMethods(db, fx.root, () => adapter, config);
      await methods['session.new']!({ workspaceId: ws.id, name: 'a' }, ctx);
      await methods['session.start']!({ workspaceId: ws.id, idOrName: 'a', run: 'claude' }, ctx);

      expect(typed).toHaveLength(2);
      expect(typed[0]).toContain('NOT trusted');
      expect(typed[1]).toBe('claude\r');
    } finally {
      db.close();
      await fx.cleanup();
    }
  }, 15_000);

  test('trusted: the hook is typed once, &&-chained with the launcher, and marked run', async () => {
    const fx = await makeGitFixture();
    const db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
    try {
      const ws = new WorkspaceManager(db).init(fx.root);
      new ConfigTrustRepo(db).setHooks(ws.id, hashHooks(hooks), 'now');
      const { adapter, typed } = recordingAdapter();
      const methods = buildMethods(db, fx.root, () => adapter, config);
      const row = (await methods['session.new']!({ workspaceId: ws.id, name: 'a' }, ctx)) as { id: string };
      await methods['session.start']!({ workspaceId: ws.id, idOrName: 'a', run: 'claude' }, ctx);

      expect(typed).toEqual([`${wrapWithSentinel('bun install')} && claude\r`]);
      expect(new SessionSetupRepo(db).has(row.id)).toBe(true);
    } finally {
      db.close();
      await fx.cleanup();
    }
  }, 15_000);

  test('a session in the project folder is never set up (no worktree of its own)', async () => {
    const fx = await makeGitFixture();
    const db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
    try {
      const ws = new WorkspaceManager(db).init(fx.root);
      new ConfigTrustRepo(db).setHooks(ws.id, hashHooks(hooks), 'now');
      const { adapter, typed } = recordingAdapter();
      const methods = buildMethods(db, fx.root, () => adapter, config);
      await methods['session.new']!({ workspaceId: ws.id, name: 'shared', worktree: false }, ctx);
      await methods['session.start']!({ workspaceId: ws.id, idOrName: 'shared', run: 'claude' }, ctx);

      expect(typed).toEqual(['claude\r']);
    } finally {
      db.close();
      await fx.cleanup();
    }
  }, 15_000);

  test('the sentinel in the shell\'s own echoed output surfaces as setup: "failed" on session.list', async () => {
    const fx = await makeGitFixture();
    const db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
    try {
      const ws = new WorkspaceManager(db).init(fx.root);
      new ConfigTrustRepo(db).setHooks(ws.id, hashHooks(hooks), 'now');
      const { adapter, emit } = scriptableAdapter();
      const methods = buildMethods(db, fx.root, () => adapter, config);
      await methods['session.new']!({ workspaceId: ws.id, name: 'a' }, ctx);

      // 'pending' before the hook is even typed (session.start does that).
      type Row = { name: string; setup?: string };
      const before = (await methods['session.list']!({ workspaceId: ws.id }, ctx)) as Row[];
      expect(before.find((r) => r.name === 'a')?.setup).toBe('pending');

      await methods['session.start']!({ workspaceId: ws.id, idOrName: 'a' }, ctx);

      // Typed but not yet resolved: neither pending (it IS typed) nor failed.
      const typing = (await methods['session.list']!({ workspaceId: ws.id }, ctx)) as Row[];
      expect(typing.find((r) => r.name === 'a')?.setup).toBeUndefined();

      // A real shell would echo the typed command, run it, then print the sentinel;
      // only the sentinel matters here.
      emit('bun install\r\n(install output)\r\n\u001b]6961;1\u0007');

      const after = (await methods['session.list']!({ workspaceId: ws.id }, ctx)) as Row[];
      expect(after.find((r) => r.name === 'a')?.setup).toBe('failed');
    } finally {
      db.close();
      await fx.cleanup();
    }
  }, 15_000);
});
