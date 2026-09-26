import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { WorkspaceManager } from '../../src/domain/workspace.js';
import type { SpawnOptions } from '../../src/adapters/types.js';
import { makeGitFixture, type GitFixture } from '../helpers/git-fixture.js';

let home: string;
let realHome: string | undefined;
let fx: GitFixture;
beforeEach(async () => {
  realHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'cw-session-home-'));
  process.env.HOME = home;
  fx = await makeGitFixture();
});
afterEach(async () => {
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
  await fx.cleanup();
});

async function harness() {
  const spawned: Array<{ kind: string; opts: SpawnOptions }> = [];
  // Stands in for the user's shell: records what it was asked to run, exits on stop.
  const factory = (kind: string) => ({
    kind, enforcementTier: 'T3' as const,
    spawn(opts: SpawnOptions) {
      spawned.push({ kind, opts });
      const exits: Array<(c: number) => void> = [];
      return { pid: 1, onData: () => undefined, onExit: (cb: (c: number) => void) => { exits.push(cb); }, write: () => undefined, resize: () => undefined, kill: () => { for (const cb of exits) cb(0); } };
    },
  });
  const db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
  const ws = new WorkspaceManager(db).init(fx.root);
  const methods = buildMethods(db, fx.root, factory, DEFAULT_CONFIG);
  const ctx = { notify: () => undefined, onClose: () => undefined };
  const call = async (m: string, p: Record<string, unknown> = {}): Promise<unknown> => methods[m]!({ workspaceId: ws.id, ...p }, ctx);
  return { db, call, spawned };
}

describe('shell sessions', () => {
  // A session is a worktree and a shell: crossweave picks no agent and launches none.
  test('new creates a worktree without starting anything; start opens the shell there', async () => {
    const { db, call, spawned } = await harness();
    try {
      const row = await call('session.new', { name: 'api' }) as { agentKind: string; worktreePath: string };
      expect(row.agentKind).toBe('shell');
      expect(spawned).toEqual([]);
      await call('session.start', { idOrName: 'api' });
      expect(spawned).toHaveLength(1);
      const first = spawned[0]!;
      expect(first.kind).toBe('shell');
      expect(first.opts.cwd).toBe(row.worktreePath);
      // Its identity and its own port block, in the shell's environment.
      const shellEnv = first.opts['env'];
      expect(shellEnv.CW_SESSION_NAME).toBe('api');
      expect(Number(shellEnv.PORT)).toBeGreaterThan(0);
      await call('session.stop', { idOrName: 'api' });
    } finally { db.close(); }
  });

  test('stop closes the shell and keeps the session; start opens a fresh one', async () => {
    const { db, call, spawned } = await harness();
    try {
      await call('session.new', { name: 'api' });
      await call('session.start', { idOrName: 'api' });
      await call('session.stop', { idOrName: 'api' });
      const listed = await call('session.list') as Array<{ name: string; status: string }>;
      expect(listed.find((s) => s.name === 'api')?.status).toBe('idle');
      await call('session.resume', { idOrName: 'api' });
      expect(spawned).toHaveLength(2);
      await call('session.stop', { idOrName: 'api' });
    } finally { db.close(); }
  });

  test('the RPCs that existed for agents and the collision guard are gone', async () => {
    const { db } = await harness();
    try {
      const methods = buildMethods(db, fx.root, undefined, DEFAULT_CONFIG);
      for (const gone of ['agents.list', 'radar.check', 'radar.reindex', 'contract.declare', 'blame', 'session.mcpInfo', 'session.reportUsage', 'usage.summary', 'session.wait', 'workspace.setSafeMode']) {
        expect(methods[gone]).toBeUndefined();
      }
    } finally { db.close(); }
  });
});

describe('session.diff', () => {
  test('a fresh session diffs to nothing; a shared one has no branch to diff', async () => {
    const { db, call } = await harness();
    try {
      await call('session.new', { name: 'own' });
      expect(await call('session.diff', { idOrName: 'own' })).toMatchObject({ files: [], patch: '', uncommitted: 0 });
      await call('session.new', { name: 'shared', worktree: false });
      await expect(call('session.diff', { idOrName: 'shared' })).rejects.toMatchObject({ code: 'DIFF_UNAVAILABLE' });
    } finally { db.close(); }
  });
});
