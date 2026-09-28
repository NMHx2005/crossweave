import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { WorkspaceManager } from '../../src/domain/workspace.js';
import type { SpawnOptions } from '../../src/adapters/types.js';

// A folder that is not a git repository, opened as a plain folder (the cockpit's "Open
// as a plain folder"): sessions run in the folder itself; nothing needs git.
let root: string;
let home: string;
let realHome: string | undefined;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cw-plain-')));
  realHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'cw-plain-home-'));
  process.env.HOME = home;
});
afterEach(() => {
  process.env.HOME = realHome;
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function harness() {
  const spawned: SpawnOptions[] = [];
  const factory = (kind: string) => ({
    kind, enforcementTier: 'T3' as const,
    spawn(opts: SpawnOptions) {
      spawned.push(opts);
      const exits: Array<(c: number) => void> = [];
      return { pid: 1, onData: () => undefined, onExit: (cb: (c: number) => void) => { exits.push(cb); }, write: () => undefined, resize: () => undefined, kill: () => { for (const cb of exits) cb(0); } };
    },
  });
  mkdirSync(join(root, '.crossweave'), { recursive: true });
  const db = openDatabase(join(root, '.crossweave', 'state.db'));
  const ws = new WorkspaceManager(db).init(root);
  const methods = buildMethods(db, root, factory, DEFAULT_CONFIG, { git: false });
  const ctx = { notify: () => undefined, onClose: () => undefined };
  const call = async (m: string, p: Record<string, unknown> = {}): Promise<unknown> => methods[m]!({ workspaceId: ws.id, ...p }, ctx);
  return { db, call, spawned };
}

describe('a plain folder (no git)', () => {
  test('says it has no git, and runs every session in the folder itself', async () => {
    const { db, call, spawned } = harness();
    try {
      expect(await call('workspace.init', {})).toMatchObject({ rootPath: root, git: false });
      // Asked for a worktree (the CLI's default), it still gets the folder: the only place there is.
      const row = await call('session.new', { name: 'notes', worktree: true }) as { worktreePath: string; branch: string | null };
      expect(row).toMatchObject({ worktreePath: root, branch: null });
      await call('session.start', { idOrName: 'notes' });
      expect(spawned[0]?.cwd).toBe(root);
      const listed = await call('session.list') as Array<{ name: string; git?: unknown }>;
      expect(listed.map((s) => s.name)).toEqual(['notes']);
      expect(listed[0]?.git).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test('has no branches, lists files by walking the folder, and diffs nothing', async () => {
    const { db, call } = harness();
    try {
      writeFileSync(join(root, 'a.md'), 'x');
      mkdirSync(join(root, 'docs'));
      writeFileSync(join(root, 'docs', 'b.md'), 'y');
      mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
      writeFileSync(join(root, 'node_modules', 'pkg', 'i.js'), 'z');
      expect(await call('git.branches')).toEqual([]);
      await call('session.new', { name: 'n', worktree: false });
      expect((await call('file.list', { idOrName: 'n' }) as string[]).sort()).toEqual(['a.md', 'docs/b.md']);
      await expect(call('session.diff', { idOrName: 'n' })).rejects.toMatchObject({ code: 'DIFF_UNAVAILABLE' });
      expect(await call('converge.status')).toMatchObject({});
    } finally {
      db.close();
    }
  });
});
