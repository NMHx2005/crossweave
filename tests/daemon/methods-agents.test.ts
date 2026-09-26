import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { WorkspaceManager } from '../../src/domain/workspace.js';
import { makeGitFixture, type GitFixture } from '../helpers/git-fixture.js';

// Settings live in the user's home; every test here gets its own, so nothing touches
// the developer's real ~/.crossweave.
let home: string;
let realHome: string | undefined;
let fx: GitFixture;
beforeEach(async () => {
  realHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'cw-agents-home-'));
  process.env.HOME = home;
  fx = await makeGitFixture();
});
afterEach(async () => {
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
  await fx.cleanup();
});

async function methodsFor() {
  const db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
  const ws = new WorkspaceManager(db).init(fx.root);
  const methods = buildMethods(db, fx.root);
  const ctx = { notify: () => undefined, onClose: () => undefined };
  const call = async (m: string, p: Record<string, unknown> = {}): Promise<unknown> => methods[m]!({ workspaceId: ws.id, ...p }, ctx);
  return { db, call };
}

describe('agent catalog RPCs', () => {
  test('agents.list shows the built-ins with their tier', async () => {
    const { db, call } = await methodsFor();
    try {
      const agents = await call('agents.list') as Array<{ id: string; tier: string; enabled: boolean }>;
      expect(agents.map((a) => a.id)).toEqual(['claude', 'codex', 'opencode', 'gemini', 'antigravity']);
      expect(agents.find((a) => a.id === 'claude')?.tier).toBe('T2');
      expect(agents.find((a) => a.id === 'codex')?.tier).toBe('T3');
    } finally { db.close(); }
  });

  test('a custom agent saved in settings can back a session, as T3', async () => {
    const { db, call } = await methodsFor();
    try {
      const settings = await call('settings.get') as { agents: unknown[] };
      await call('settings.set', { settings: { ...settings, agents: [...settings.agents, { id: 'mine', label: 'Mine', command: 'sh -c "exit 0"', enabled: true, builtin: false }] } });
      const row = await call('session.new', { name: 'custom', agent: 'mine' }) as { agentKind: string; enforcementTier: string };
      expect(row).toMatchObject({ agentKind: 'mine', enforcementTier: 'T3' });
    } finally { db.close(); }
  });

  test('a disabled agent cannot back a new session', async () => {
    const { db, call } = await methodsFor();
    try {
      const settings = await call('settings.get') as { agents: Array<{ id: string; enabled: boolean }> };
      await call('settings.set', { settings: { ...settings, agents: settings.agents.map((a) => a.id === 'gemini' ? { ...a, enabled: false } : a) } });
      await expect(call('session.new', { name: 'g', agent: 'gemini' })).rejects.toMatchObject({ code: 'AGENT_DISABLED' });
    } finally { db.close(); }
  });

  test('settings.set refuses invalid settings and leaves the file as it was', async () => {
    const { db, call } = await methodsFor();
    try {
      const before = await call('settings.get');
      await expect(call('settings.set', { settings: { ...(before as object), editor: { kind: 'emacs' } } })).rejects.toMatchObject({ code: 'INVALID_SETTINGS' });
      expect(await call('settings.get')).toEqual(before);
    } finally { db.close(); }
  });
});
