import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { WorkspaceManager } from '../../src/domain/workspace.js';
import type { SpawnOptions } from '../../src/adapters/types.js';
import { makeGitFixture, type GitFixture } from '../helpers/git-fixture.js';
import { claudeProjectDir } from '../../src/domain/agent-logs.js';

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

describe('session status on session.list', () => {
  // Inferred from the shell, since crossweave no longer launches agents: typing makes
  // output, output is work, and quiet is idle for a plain shell.
  test('a shell that is producing output is working; quiet again, it is idle', async () => {
    let now = 1_000_000;
    let emit: (chunk: string) => void = () => undefined;
    const factory = (kind: string) => ({
      kind, enforcementTier: 'T3' as const,
      spawn() {
        const data: Array<(c: string) => void> = [];
        const exits: Array<(c: number) => void> = [];
        emit = (c) => { for (const cb of data) cb(c); };
        return {
          pid: 4242, onData: (cb: (c: string) => void) => { data.push(cb); }, onExit: (cb: (c: number) => void) => { exits.push(cb); },
          write: () => { emit('output\r\n'); }, resize: () => undefined, kill: () => { for (const cb of exits) cb(129); },
        };
      },
    });
    const db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
    try {
      const ws = new WorkspaceManager(db).init(fx.root);
      const methods = buildMethods(db, fx.root, factory, DEFAULT_CONFIG, { now: () => now });
      const ctx = { notify: () => undefined, onClose: () => undefined };
      const call = async (m: string, p: Record<string, unknown> = {}): Promise<unknown> => methods[m]!({ workspaceId: ws.id, ...p }, ctx);
      const status = async () => (await call('session.list') as Array<{ name: string; activity: string; agent: string | null; lastActivityAt: number | null }>)
        .find((s) => s.name === 'api')!;

      await call('session.new', { name: 'api' });
      await call('session.start', { idOrName: 'api' });
      expect(await status()).toMatchObject({ activity: 'idle', agent: null, lastActivityAt: null });
      await call('session.input', { idOrName: 'api', data: 'ls\r' });
      expect(await status()).toMatchObject({ activity: 'working', lastActivityAt: now });
      now += 5000;
      expect((await status()).activity).toBe('idle');
      // Stopping it is not a failure, even though a hung-up shell exits 129.
      await call('session.stop', { idOrName: 'api' });
      expect((await status()).activity).toBe('idle');
    } finally { db.close(); }
  });
});

describe('launchers', () => {
  // The launcher's command is typed into the shell the session just opened, and the
  // launcher's env reaches that shell (a lease still wins over it).
  test('start can run a command in the new shell, with extra environment', async () => {
    const typed: string[] = [];
    let seenEnv: Record<string, string> = {};
    const factory = (kind: string) => ({
      kind, enforcementTier: 'T3' as const,
      spawn(opts: SpawnOptions) {
        seenEnv = opts['env'];
        const exits: Array<(c: number) => void> = [];
        return { pid: 7, onData: () => undefined, onExit: (cb: (c: number) => void) => { exits.push(cb); }, write: (d: string) => { typed.push(d); }, resize: () => undefined, kill: () => { for (const cb of exits) cb(129); } };
      },
    });
    const db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
    try {
      const ws = new WorkspaceManager(db).init(fx.root);
      const methods = buildMethods(db, fx.root, factory, DEFAULT_CONFIG);
      const ctx = { notify: () => undefined, onClose: () => undefined };
      const call = async (m: string, p: Record<string, unknown> = {}): Promise<unknown> => methods[m]!({ workspaceId: ws.id, ...p }, ctx);
      await call('session.new', { name: 'api' });
      await call('session.start', { idOrName: 'api', run: 'claude --model opus', env: { ANTHROPIC_MODEL: 'opus', PORT: '1' } });
      expect(typed).toEqual(['claude --model opus\r']);
      expect(seenEnv.ANTHROPIC_MODEL).toBe('opus');
      expect(seenEnv.PORT).not.toBe('1');
      await call('session.stop', { idOrName: 'api' });
      // A second line would run a second command: refused before anything starts.
      await expect(call('session.start', { idOrName: 'api', run: 'claude\nrm -rf x' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
      expect(typed).toHaveLength(1);
    } finally { db.close(); }
  });

  test('launchers.list says which launchers this machine can run', async () => {
    const { db, call } = await harness();
    try {
      const list = await call('launchers.list') as Array<{ id: string; available: boolean; enabled: boolean }>;
      expect(list.map((l) => l.id)).toContain('claude');
      expect(list.every((l) => typeof l.available === 'boolean')).toBe(true);
    } finally { db.close(); }
  });
});

describe('starting with a saved launcher', () => {
  test('its command is typed and its env applied; unknown or disabled ones are refused', async () => {
    const { saveSettings, loadSettings } = await import('../../src/core/settings.js');
    const base = loadSettings(home);
    saveSettings({
      ...base,
      launchers: base.launchers.map((l) => (l.id === 'claude' ? { ...l, command: 'claude --model opus', env: { FOO: 'bar' } }
        : l.id === 'aider' ? { ...l, enabled: false } : l)),
    }, home);
    const typed: string[] = [];
    let seenEnv: Record<string, string> = {};
    const factory = (kind: string) => ({
      kind, enforcementTier: 'T3' as const,
      spawn(opts: SpawnOptions) {
        seenEnv = opts['env'];
        const exits: Array<(c: number) => void> = [];
        return { pid: 7, onData: () => undefined, onExit: (cb: (c: number) => void) => { exits.push(cb); }, write: (d: string) => { typed.push(d); }, resize: () => undefined, kill: () => { for (const cb of exits) cb(129); } };
      },
    });
    const db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
    try {
      const ws = new WorkspaceManager(db).init(fx.root);
      const methods = buildMethods(db, fx.root, factory, DEFAULT_CONFIG);
      const ctx = { notify: () => undefined, onClose: () => undefined };
      const call = async (m: string, p: Record<string, unknown> = {}): Promise<unknown> => methods[m]!({ workspaceId: ws.id, ...p }, ctx);
      await call('session.new', { name: 'api' });
      await expect(call('session.start', { idOrName: 'api', launcher: 'nope' })).rejects.toMatchObject({ code: 'UNKNOWN_LAUNCHER' });
      await expect(call('session.start', { idOrName: 'api', launcher: 'aider' })).rejects.toMatchObject({ code: 'LAUNCHER_DISABLED' });
      await call('session.start', { idOrName: 'api', launcher: 'claude' });
      expect(typed).toEqual(['claude --model opus\r']);
      expect(seenEnv.FOO).toBe('bar');
      await call('session.stop', { idOrName: 'api' });
      // "terminal" is a plain shell: nothing typed.
      await call('session.start', { idOrName: 'api', launcher: 'terminal' });
      expect(typed).toHaveLength(1);
      await call('session.stop', { idOrName: 'api' });
    } finally { db.close(); }
  });
});

describe('session.list git counts', () => {
  test('a worktree session gains its uncommitted-file count once the background read lands', async () => {
    const { db, call } = await harness();
    try {
      const created = await call('session.new', { name: 'api' }) as { worktreePath: string };
      await Bun.write(join(created.worktreePath, 'new-file.txt'), 'x');
      await call('session.list');
      let git: unknown;
      for (let i = 0; i < 50 && git === undefined; i++) {
        await Bun.sleep(20);
        git = (await call('session.list') as Array<{ name: string; git?: unknown }>).find((s) => s.name === 'api')?.git;
      }
      expect(git).toEqual({ changed: 1, ahead: 0 });
    } finally { db.close(); }
  });
});

describe('usage on the session list', () => {
  const claudeLog = (cwd: string, name: string, output: number): void => {
    const dir = claudeProjectDir(home, cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.jsonl`), `${JSON.stringify({
      type: 'assistant', timestamp: new Date(Date.now() + 1000).toISOString(),
      message: { id: name, model: 'claude-opus', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    })}\n`);
  };
  type Row = { name: string; usage?: { total: { output: number } } };
  const listed = async (call: (m: string) => Promise<unknown>): Promise<Row[]> => {
    await call('session.list');
    // The figures are read in the background; the next list carries them.
    await new Promise((r) => setTimeout(r, 100));
    return await call('session.list') as Row[];
  };

  // Every Claude run in the project folder writes to the same log folder — one in a
  // terminal outside crossweave included — so none of it can be told apart and
  // credited to a session there. Regression: a session nobody had used showed 326M.
  test('a session in the project folder shows no usage; a worktree session shows its own', async () => {
    const { db, call } = await harness();
    try {
      await call('session.new', { name: 'here', worktree: false });
      const tree = await call('session.new', { name: 'tree', worktree: true }) as { worktreePath: string };
      claudeLog(fx.root, 'outside', 500);
      claudeLog(tree.worktreePath, 'inside', 7);
      const rows = await listed((m) => call(m));
      expect(rows.find((r) => r.name === 'here')?.usage).toBeUndefined();
      expect(rows.find((r) => r.name === 'tree')?.usage?.total.output).toBe(7);
    } finally {
      db.close();
    }
  });
});
