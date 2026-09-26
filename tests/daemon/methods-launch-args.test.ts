import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { WorkspaceManager } from '../../src/domain/workspace.js';
import { makeGitFixture, type GitFixture } from '../helpers/git-fixture.js';

let home: string;
let realHome: string | undefined;
let fx: GitFixture;
beforeEach(async () => {
  realHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'cw-launch-home-'));
  process.env.HOME = home;
  fx = await makeGitFixture();
});
afterEach(async () => {
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
  await fx.cleanup();
});

async function harness() {
  const spawned: Array<string[] | undefined> = [];
  // Records the flags it was asked to spawn with; the "agent" exits when stopped.
  const factory = (kind: string) => ({
    kind, enforcementTier: 'T2' as const,
    spawn(opts: { extraArgs?: string[] }) {
      spawned.push(opts.extraArgs);
      const exits: Array<(c: number) => void> = [];
      return { pid: 1, onData: () => undefined, onExit: (cb: (c: number) => void) => { exits.push(cb); }, write: () => undefined, resize: () => undefined, kill: () => { for (const cb of exits) cb(0); } };
    },
  });
  const db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
  const ws = new WorkspaceManager(db).init(fx.root);
  const methods = buildMethods(db, fx.root, factory as never, { ...DEFAULT_CONFIG, sandbox: { enabled: false, network: true } });
  const ctx = { notify: () => undefined, onClose: () => undefined };
  const call = async (m: string, p: Record<string, unknown> = {}): Promise<unknown> => methods[m]!({ workspaceId: ws.id, ...p }, ctx);
  const listed = async (name: string) => (await call('session.list') as Array<{ name: string; launchArgs: string[] | null }>).find((s) => s.name === name);
  return { db, call, spawned, listed };
}

describe('per-session launch flags', () => {
  test('creating a session does not start it, and remembers the flags it was given', async () => {
    const { db, call, spawned, listed } = await harness();
    try {
      await call('session.new', { name: 'api', agent: 'claude', args: ['--model', 'opus'] });
      expect(spawned).toEqual([]);
      expect((await listed('api'))?.launchArgs).toEqual(['--model', 'opus']);
    } finally { db.close(); }
  });

  test('start without flags reuses the remembered ones; start with flags replaces them', async () => {
    const { db, call, spawned, listed } = await harness();
    try {
      await call('session.new', { name: 'api', agent: 'claude', args: ['--model', 'opus'] });
      await call('session.start', { idOrName: 'api' });
      expect(spawned.at(-1)).toEqual(['--model', 'opus']);
      await call('session.stop', { idOrName: 'api' });

      await call('session.resume', { idOrName: 'api', args: ['--dangerously-skip-permissions'] });
      expect(spawned.at(-1)).toEqual(['--dangerously-skip-permissions']);
      expect((await listed('api'))?.launchArgs).toEqual(['--dangerously-skip-permissions']);
      await call('session.stop', { idOrName: 'api' });

      // An empty list is a choice too: back to the agent's plain command.
      await call('session.start', { idOrName: 'api', args: [] });
      expect(spawned.at(-1)).toEqual([]);
      await call('session.stop', { idOrName: 'api' });
    } finally { db.close(); }
  }, 20_000);

  test('a session never given flags has none', async () => {
    const { db, call, listed } = await harness();
    try {
      await call('session.new', { name: 'plain', agent: 'claude' });
      expect((await listed('plain'))?.launchArgs).toBeNull();
    } finally { db.close(); }
  });

  test('bad flags are refused before anything is stored or spawned', async () => {
    const { db, call, spawned, listed } = await harness();
    try {
      await expect(call('session.new', { name: 'x', agent: 'claude', args: ['--settings', '{}'] }))
        .rejects.toMatchObject({ code: 'INVALID_LAUNCH_ARGS' });
      expect(await listed('x')).toBeUndefined();
      await call('session.new', { name: 'y', agent: 'claude', args: ['--model', 'opus'] });
      await expect(call('session.start', { idOrName: 'y', args: 'not a list' }))
        .rejects.toMatchObject({ code: 'INVALID_LAUNCH_ARGS' });
      expect(spawned).toEqual([]);
      expect((await listed('y'))?.launchArgs).toEqual(['--model', 'opus']);
    } finally { db.close(); }
  });
});

describe('session.diff', () => {
  test('a fresh session diffs to nothing; a shared one has no branch to diff', async () => {
    const { db, call } = await harness();
    try {
      await call('session.new', { name: 'own', agent: 'claude' });
      expect(await call('session.diff', { idOrName: 'own' })).toMatchObject({ files: [], patch: '', uncommitted: 0 });
      await call('session.new', { name: 'shared', agent: 'claude', worktree: false });
      await expect(call('session.diff', { idOrName: 'shared' })).rejects.toMatchObject({ code: 'DIFF_UNAVAILABLE' });
    } finally { db.close(); }
  });
});
