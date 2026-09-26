import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { readJournal } from '../../src/domain/journal.js';

const ctx = { notify: () => undefined, onClose: () => undefined };

let db: Database | undefined;
let dir: string | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/**
 * `root_path` is UNIQUE, so the only way a journal can name a workspace that no longer
 * owns its root is `workspace.delete` + a fresh `init` on the same path — which reuses
 * the path and leaves the file behind. `ws_2` stands in for that: a different workspace
 * on a different root, asking about a journal that is not its own.
 */
function setup() {
  dir = mkdtempSync(join(tmpdir(), 'cw-journal-rpc-'));
  const database = openDatabase(':memory:');
  db = database;
  const workspaces = new WorkspaceRepo(database);
  for (const [id, root] of [['ws_1', dir], ['ws_2', `${dir}_other`]] as const) {
    workspaces.insert({
      id, name: id, rootPath: root, createdAt: 'now', defaultIsolation: 'worktree', safeModeTier: 'T2',
    });
  }
  const sessions = new SessionRepo(database);
  const insert = (id: string, agentKind: string) => {
    sessions.insert({
      id, workspaceId: 'ws_1', name: id, agentKind, adapter: agentKind,
      status: 'idle', worktreePath: `${dir}/${id}`, branch: `cw/${id}`, createdAt: 'now',
      lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costBudgetUsd: null,
      costSpentUsd: 0, enforcementTier: 'T2', pid: null, launchArgs: null,
    });
  };
  insert('s_a', 'claude');
  insert('s_b', 'claude');
  // The integration session is infrastructure the user cannot address — never a pane.
  insert('s_integration', 'integration');
  return buildMethods(database, dir!, undefined, DEFAULT_CONFIG);
}

describe('journal.get / journal.set', () => {
  test('an unwritten journal reads as empty rather than as an error', async () => {
    const methods = setup();
    expect(await methods['journal.get']!({ workspaceId: 'ws_1' }, ctx)).toEqual({
      workspaceId: 'ws_1', openTabs: [], fileSurfaces: [], at: null,
    });
  });

  test('set keeps this workspace\'s real sessions and drops the rest, in order', async () => {
    const methods = setup();
    const result = await methods['journal.set']!(
      { workspaceId: 'ws_1', openTabs: ['s_b', 'ghost', 's_integration', 's_a', 's_b', 7] },
      ctx,
    );
    expect(result).toEqual({ openTabs: ['s_b', 's_a'] });
    expect(await methods['journal.get']!({ workspaceId: 'ws_1' }, ctx)).toMatchObject({
      workspaceId: 'ws_1', openTabs: ['s_b', 's_a'], fileSurfaces: [],
    });
    // The file is the daemon's, and it is the daemon that wrote what it pruned.
    expect(readJournal(dir!)?.openTabs).toEqual(['s_b', 's_a']);
  });

  test('a journal from another workspace reads as empty and is left alone', async () => {
    const methods = setup();
    await methods['journal.set']!({ workspaceId: 'ws_1', openTabs: ['s_a'] }, ctx);
    expect(await methods['journal.get']!({ workspaceId: 'ws_2' }, ctx)).toMatchObject({ openTabs: [] });
    expect(readJournal(dir!)?.workspaceId).toBe('ws_1');
  });

  test('a later set replaces the previous pane set instead of appending to it', async () => {
    const methods = setup();
    await methods['journal.set']!({ workspaceId: 'ws_1', openTabs: ['s_a', 's_b'] }, ctx);
    await methods['journal.set']!({ workspaceId: 'ws_1', openTabs: ['s_b'] }, ctx);
    expect(readJournal(dir!)?.openTabs).toEqual(['s_b']);
  });
});
