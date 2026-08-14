import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';

function seed() {
  const db = openDatabase(':memory:');
  new WorkspaceRepo(db).insert({
    id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
    defaultIsolation: 'worktree', safeModeTier: 'T2',
  });
  return db;
}

const ctx = { notify: () => undefined, onClose: () => undefined };

describe('config.setNotify RPC', () => {
  test('no event: sets the master enabled switch', async () => {
    const db = seed();
    const methods = buildMethods(db, '/tmp/w');
    const result = (await methods['config.setNotify']!({ workspaceId: 'ws_1', enabled: false }, ctx)) as { enabled: boolean };
    expect(result.enabled).toBe(false);
  });

  test('with event: sets exactly that column, leaves enabled and the others alone', async () => {
    const db = seed();
    const methods = buildMethods(db, '/tmp/w');
    const result = (await methods['config.setNotify']!(
      { workspaceId: 'ws_1', event: 'collision', enabled: false }, ctx,
    )) as { enabled: boolean; collision: boolean; blocked: boolean };
    expect(result.collision).toBe(false);
    expect(result.enabled).toBe(true);
    expect(result.blocked).toBe(true);
  });
});

describe('config.status RPC: notify section', () => {
  test('reports every default true when nothing has been toggled', async () => {
    const db = seed();
    const methods = buildMethods(db, '/tmp/w');
    const result = (await methods['config.status']!({ workspaceId: 'ws_1' }, ctx)) as {
      notify: { enabled: boolean; collision: boolean; blocked: boolean; land: boolean; convergence: boolean };
    };
    expect(result.notify).toEqual({ enabled: true, collision: true, blocked: true, land: true, convergence: true });
  });

  test('reflects a prior config.setNotify call', async () => {
    const db = seed();
    const methods = buildMethods(db, '/tmp/w');
    await methods['config.setNotify']!({ workspaceId: 'ws_1', event: 'land', enabled: false }, ctx);
    const result = (await methods['config.status']!({ workspaceId: 'ws_1' }, ctx)) as {
      notify: { land: boolean };
    };
    expect(result.notify.land).toBe(false);
  });
});
