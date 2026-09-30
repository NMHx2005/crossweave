import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/open.js';
import { TerminalRepo } from '../../src/db/repositories/terminal.js';
import { SessionRepo, type SessionRow } from '../../src/db/repositories/session.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { TerminalRegistry, type PersistDeps } from '../../src/daemon/terminals.js';
import type { AgentProcess } from '../../src/adapters/types.js';
import type { MethodContext } from '../../src/daemon/server.js';

/** A shell double: the test decides what it prints and when it ends. */
class FakeShell implements AgentProcess {
  readonly pid = 1;
  private data: Array<(c: string) => void> = [];
  private exit: Array<(c: number) => void> = [];
  killed: string[] = [];
  onData(cb: (c: string) => void): void { this.data.push(cb); }
  onExit(cb: (c: number) => void): void { this.exit.push(cb); }
  write(): void {}
  resize(): void {}
  kill(signal?: NodeJS.Signals): void { this.killed.push(String(signal)); queueMicrotask(() => this.end(0)); }
  print(chunk: string): void { for (const cb of this.data) cb(chunk); }
  end(code: number): void { for (const cb of this.exit) cb(code); }
}

function setup(opts: { enabled?: boolean; worktree?: string | null } = {}) {
  const db = openDatabase(':memory:');
  new WorkspaceRepo(db).insert({ id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now', defaultIsolation: 'worktree', safeModeTier: 'T1' });
  const worktree = opts.worktree === undefined ? mkdtempSync(join(tmpdir(), 'cw-term-')) : opts.worktree;
  const sessions = new SessionRepo(db);
  sessions.insert({
    id: 's_1', workspaceId: 'ws_1', name: 'alpha', agentKind: 'shell', adapter: 'shell', status: 'running', worktreePath: worktree, branch: null,
    createdAt: 'now', lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null, enforcementTier: 'T3', pid: null, launchArgs: null,
  });
  const repo = new TerminalRepo(db);
  const state = { enabled: opts.enabled ?? true };
  const shells: FakeShell[] = [];
  let tick: (() => void) | undefined;
  const persist: PersistDeps = {
    enabled: () => state.enabled,
    repo,
    now: () => new Date('2026-09-29T10:00:00.000Z'),
    clock: { setInterval: (fn) => { tick = fn; return 1; }, clearInterval: () => { tick = undefined; } },
  };
  const make = (p: PersistDeps | null = persist) => new TerminalRegistry(() => { const s = new FakeShell(); shells.push(s); return s; }, undefined, p ?? undefined);
  const row = (): SessionRow => sessions.findById('s_1') as SessionRow;
  return { db, repo, sessions, state, shells, make, row, flush: () => tick?.(), hasTick: () => tick !== undefined };
}

const ctx = (): MethodContext & { got: string[] } => {
  const got: string[] = [];
  return { got, notify: (m, p) => { if (m === 'terminal.data') got.push((p as { chunk: string }).chunk); }, onClose: () => undefined };
};

describe('persistence off (the default)', () => {
  test('nothing is written: no row on open, no snapshot on flush', () => {
    const t = setup({ enabled: false });
    const reg = t.make();
    reg.open(t.row());
    t.shells[0]!.print('secret output\r\n');
    t.flush();
    expect(t.repo.listAll()).toEqual([]);
  });

  test('a registry with no persistence at all behaves exactly as before', async () => {
    const t = setup();
    const reg = t.make(null);
    const info = reg.open(t.row());
    t.shells[0]!.print('x');
    expect(reg.list('ws_1').map((i) => i.terminalId)).toEqual([info.terminalId]);
    await reg.closeAll();
    expect(t.repo.listAll()).toEqual([]);
  });
});

describe('persistence on', () => {
  test('opening a terminal records its descriptor under its own id', () => {
    const t = setup();
    const reg = t.make();
    const info = reg.open(t.row());
    expect(t.repo.get(info.terminalId)).toMatchObject({ id: info.terminalId, workspaceId: 'ws_1', sessionId: 's_1', snapshot: null });
  });

  test('a flush saves the output of a terminal that changed, and skips one that did not', () => {
    const t = setup();
    const reg = t.make();
    const a = reg.open(t.row());
    const b = reg.open(t.row());
    t.shells[0]!.print('hello a\r\n');
    t.flush();
    expect(t.repo.get(a.terminalId)?.snapshot).toBe('hello a\r\n');
    expect(t.repo.get(b.terminalId)?.snapshot).toBeNull(); // never wrote anything
    t.repo.setSnapshot(a.terminalId, 'CHANGED BY HAND', 'x');
    t.flush(); // a is no longer dirty: not rewritten
    expect(t.repo.get(a.terminalId)?.snapshot).toBe('CHANGED BY HAND');
  });

  test('closing the daemon (closeAll) snapshots first and KEEPS the rows for the next start', async () => {
    const t = setup();
    const reg = t.make();
    const info = reg.open(t.row());
    t.shells[0]!.print('last words\r\n');
    await reg.closeAll();
    expect(t.repo.get(info.terminalId)?.snapshot).toBe('last words\r\n');
  });

  test('a terminal the user closes is deleted, snapshot and all', async () => {
    const t = setup();
    const reg = t.make();
    const info = reg.open(t.row());
    t.shells[0]!.print('private\r\n');
    t.flush();
    await reg.close(info.terminalId);
    expect(t.repo.get(info.terminalId)).toBeUndefined();
  });

  test('a shell that ends on its own is gone, not restored', () => {
    const t = setup();
    const reg = t.make();
    const info = reg.open(t.row());
    t.shells[0]!.end(0);
    expect(t.repo.get(info.terminalId)).toBeUndefined();
    expect(reg.list('ws_1')).toEqual([]);
  });

  test('closing a session\'s terminals deletes their rows', async () => {
    const t = setup();
    const reg = t.make();
    const a = reg.open(t.row());
    const b = reg.open(t.row());
    await reg.closeForSession('s_1');
    expect(t.repo.get(a.terminalId)).toBeUndefined();
    expect(t.repo.get(b.terminalId)).toBeUndefined();
  });

  test('switching persistence off removes every stored snapshot at the next flush', () => {
    const t = setup();
    const reg = t.make();
    const info = reg.open(t.row());
    t.shells[0]!.print('x');
    t.flush();
    expect(t.repo.get(info.terminalId)?.snapshot).toBe('x');
    t.state.enabled = false;
    t.flush();
    expect(t.repo.listAll()).toEqual([]);
  });

  test('a flush timer runs while terminals are open, and stops with closeAll', async () => {
    const t = setup();
    const reg = t.make();
    reg.open(t.row());
    expect(t.hasTick()).toBe(true);
    await reg.closeAll();
    expect(t.hasTick()).toBe(false);
  });
});

describe('restore', () => {
  test('after a restart the terminal comes back with the SAME id, marked restored, replaying its output', async () => {
    const t = setup();
    const first = t.make();
    const info = first.open(t.row());
    t.shells[0]!.print('before the restart\r\n');
    await first.closeAll();

    const second = t.make();
    const restored = second.restore(t.repo.listAll(), (id) => (id === 's_1' ? t.row() : undefined));
    expect(restored).toBe(1);
    expect(second.list('ws_1')).toEqual([expect.objectContaining({ terminalId: info.terminalId, restored: true })]);

    const c = ctx();
    second.subscribe(info.terminalId, c);
    const replay = c.got.join('');
    expect(replay).toContain('before the restart');
    expect(replay).toMatch(/new shell/i);
    expect(replay.startsWith('\x1bc')).toBe(true);
  });

  test('a fresh terminal after a restore is not marked restored', async () => {
    const t = setup();
    const first = t.make();
    first.open(t.row());
    await first.closeAll();
    const second = t.make();
    second.restore(t.repo.listAll(), () => t.row());
    const fresh = second.open(t.row());
    expect(second.list('ws_1').find((i) => i.terminalId === fresh.terminalId)?.restored).toBeFalsy();
  });

  test('a terminal whose session is gone is dropped, row and all', async () => {
    const t = setup();
    const first = t.make();
    const info = first.open(t.row());
    await first.closeAll();
    const second = t.make();
    expect(second.restore(t.repo.listAll(), () => undefined)).toBe(0);
    expect(t.repo.get(info.terminalId)).toBeUndefined();
  });

  test('a terminal whose worktree is gone is dropped too', async () => {
    const t = setup({ worktree: '/definitely/not/here' });
    const first = t.make();
    const info = first.open(t.row());
    await first.closeAll();
    const second = t.make();
    expect(second.restore(t.repo.listAll(), () => t.row())).toBe(0);
    expect(t.repo.get(info.terminalId)).toBeUndefined();
  });

  test('restoring while persistence is off restores nothing and clears the rows', async () => {
    const t = setup();
    const first = t.make();
    first.open(t.row());
    await first.closeAll();
    t.state.enabled = false;
    const second = t.make();
    expect(second.restore(t.repo.listAll(), () => t.row())).toBe(0);
    expect(t.repo.listAll()).toEqual([]);
  });

  test('a restored terminal that then ends is deleted like any other', async () => {
    const t = setup();
    const first = t.make();
    const info = first.open(t.row());
    await first.closeAll();
    const second = t.make();
    second.restore(t.repo.listAll(), () => t.row());
    t.shells[t.shells.length - 1]!.end(0);
    expect(t.repo.get(info.terminalId)).toBeUndefined();
  });
});

describe('the periodic flush never throws', () => {
  // Found by repeating the whole suite: a registry's 30 s timer outlived a test that closed its database, fired
  // during ANOTHER test and threw "Cannot use a closed database" there, failing an unrelated test at random. A timer
  // callback has no caller to handle an error, so whatever the database does, it must not escape.
  test('a tick after the database is gone is swallowed, with persistence on and off', () => {
    for (const enabled of [true, false]) {
      const t = setup({ enabled });
      const reg = t.make();
      reg.open(t.row());
      t.shells[0]!.print('output\r\n');
      t.db.close();
      expect(() => t.flush()).not.toThrow();
      void reg;
    }
  });

  test('and it says so once, not on every tick', () => {
    const lines: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      const t = setup({ enabled: true });
      const reg = t.make();
      reg.open(t.row());
      t.shells[0]!.print('x');
      t.db.close();
      t.flush();
      t.flush();
      t.flush();
      void reg;
    } finally {
      process.stderr.write = original;
    }
    expect(lines.filter((l) => l.includes('could not save terminal output'))).toHaveLength(1);
  });
});
