import { describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { WorkspaceManager } from '../../src/domain/workspace.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { makeGitFixture } from '../helpers/git-fixture.js';

async function until(pred: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * The Terminal pane's daemon side. `/bin/sh` rather than the user's login shell, so the
 * test does not depend on (or run) anyone's zsh profile; sandbox off, since a CI host
 * may have no provider — the sandboxed spawn path is the same `planSandbox` the agent's
 * is, and tests/isolation/sandbox.test.ts covers that boundary.
 */
async function setup() {
  const fx = await makeGitFixture();
  const db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
  const ws = new WorkspaceManager(db).init(fx.root);
  const methods = buildMethods(db, fx.root, undefined, DEFAULT_CONFIG, { shell: '/bin/sh' });
  const seen: Array<[string, Record<string, unknown>]> = [];
  const ctx = { notify: (m: string, p: unknown) => { seen.push([m, p as Record<string, unknown>]); }, onClose: () => undefined };
  const call = async (m: string, p: Record<string, unknown> = {}): Promise<unknown> => methods[m]!({ workspaceId: ws.id, ...p }, ctx);
  const text = (terminalId: string) => seen
    .filter(([m, p]) => m === 'terminal.data' && p.terminalId === terminalId)
    .map(([, p]) => String(p.chunk)).join('');
  // Not daemon.shutdown: it ends with process.exit, which would take the test runner.
  const cleanup = async () => {
    for (const term of await call('terminal.list') as Array<{ terminalId: string }>) {
      await call('terminal.close', { terminalId: term.terminalId }).catch(() => undefined);
    }
    db.close();
    await fx.cleanup();
  };
  return { fx, ws, call, seen, text, cleanup };
}

describe('terminal RPCs', () => {
  test('open a shell in the session worktree, type into it, list it, close it', async () => {
    const t = await setup();
    try {
      const row = await t.call('session.new', { name: 'dev', agent: 'claude' }) as { worktreePath: string };
      const opened = await t.call('terminal.open', { idOrName: 'dev' }) as { terminalId: string; sessionName: string };
      expect(opened.sessionName).toBe('dev');
      await t.call('terminal.attach', { terminalId: opened.terminalId });
      await t.call('terminal.input', { terminalId: opened.terminalId, data: 'pwd\n' });
      await until(() => t.text(opened.terminalId).includes(row.worktreePath.split('/').pop()!));
      expect((await t.call('terminal.list') as unknown[]).length).toBe(1);

      await t.call('terminal.close', { terminalId: opened.terminalId });
      expect(await t.call('terminal.list')).toEqual([]);
      expect(t.seen.some(([m, p]) => m === 'terminal.exit' && p.terminalId === opened.terminalId)).toBe(true);
    } finally {
      await t.cleanup();
    }
  }, 20_000);

  // Removing a session removes its worktree; a shell left running in it would sit in
  // a deleted directory.
  test('removing the session closes its terminals first', async () => {
    const t = await setup();
    try {
      await t.call('session.new', { name: 'gone', agent: 'claude' });
      const { terminalId } = await t.call('terminal.open', { idOrName: 'gone' }) as { terminalId: string };
      await t.call('terminal.attach', { terminalId });
      await t.call('session.kill', { idOrName: 'gone' });
      // Killing keeps the worktree (it may still be landed), so the shell stays.
      expect((await t.call('terminal.list') as unknown[]).length).toBe(1);
      await t.call('session.rm', { idOrName: 'gone' });
      expect(await t.call('terminal.list')).toEqual([]);
      expect(t.seen.some(([m, p]) => m === 'terminal.exit' && p.terminalId === terminalId)).toBe(true);
    } finally {
      await t.cleanup();
    }
  }, 20_000);

  test('refuses a session whose worktree no longer exists, in one CODE line', async () => {
    const t = await setup();
    try {
      const row = await t.call('session.new', { name: 'nowt', agent: 'claude' }) as { worktreePath: string };
      // The row survives but its directory does not (deleted by hand, or a crash
      // mid-removal) — `kill --rm-worktree` would remove the row as well.
      rmSync(row.worktreePath, { recursive: true, force: true });
      expect(existsSync(row.worktreePath)).toBe(false);
      await expect(t.call('terminal.open', { idOrName: 'nowt' })).rejects.toMatchObject({ code: 'SESSION_NO_WORKDIR' });
    } finally {
      await t.cleanup();
    }
  }, 20_000);

  test('an unknown terminal id is TERMINAL_NOT_FOUND', async () => {
    const t = await setup();
    try {
      await expect(t.call('terminal.input', { terminalId: 't_nope', data: 'x' })).rejects.toMatchObject({ code: 'TERMINAL_NOT_FOUND' });
    } finally {
      await t.cleanup();
    }
  }, 20_000);
});
