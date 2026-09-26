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

describe('resume and latest words', () => {
  test('a restart reopens the session\'s own conversation, and the list shows its last words', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { claudeProjectDir } = await import('../../src/domain/agent-logs.js');
    const spawned: Array<{ resumeId?: string }> = [];
    // Records what it was asked to spawn; the "agent" exits when stopped.
    const factory = (kind: string) => ({
      kind, enforcementTier: 'T2' as const,
      spawn(opts: { resumeId?: string }) {
        spawned.push({ ...(opts.resumeId === undefined ? {} : { resumeId: opts.resumeId }) });
        const exits: Array<(c: number) => void> = [];
        return { pid: 1, onData: () => undefined, onExit: (cb: (c: number) => void) => { exits.push(cb); }, write: () => undefined, resize: () => undefined, kill: () => { for (const cb of exits) cb(0); } };
      },
    });
    const db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
    try {
      const ws = new WorkspaceManager(db).init(fx.root);
      const config = { ...(await import('../../src/core/config.js')).DEFAULT_CONFIG, sandbox: { enabled: false, network: true } };
      const methods = buildMethods(db, fx.root, factory as never, config);
      const ctx = { notify: () => undefined, onClose: () => undefined };
      const call = async (m: string, p: Record<string, unknown> = {}): Promise<unknown> => methods[m]!({ workspaceId: ws.id, ...p }, ctx);

      const row = await call('session.new', { name: 'talk', agent: 'claude' }) as { worktreePath: string };
      await call('session.start', { idOrName: 'talk' });
      expect(spawned.at(-1)?.resumeId).toBeUndefined();

      // The agent wrote a conversation for this worktree.
      const dir = claudeProjectDir(home, row.worktreePath);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'conv-1.jsonl'), `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Refactor done.' }] } })}\n`);

      await call('session.stop', { idOrName: 'talk' });
      await call('session.start', { idOrName: 'talk' });
      expect(spawned.at(-1)?.resumeId).toBe('conv-1');

      const listed = await call('session.list') as Array<{ name: string; latestWords?: string }>;
      expect(listed.find((s) => s.name === 'talk')?.latestWords).toBe('Refactor done.');
      await call('session.stop', { idOrName: 'talk' });
    } finally { db.close(); }
  }, 20_000);
});
