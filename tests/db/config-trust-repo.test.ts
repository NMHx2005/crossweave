import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { ConfigTrustRepo } from '../../src/db/repositories/config-trust.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';

function seed(db: ReturnType<typeof openDatabase>) {
  new WorkspaceRepo(db).insert({
    id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
    defaultIsolation: 'worktree', safeModeTier: 'T1',
  });
}

describe('ConfigTrustRepo', () => {
  test('get returns undefined for a workspace that never trusted anything', () => {
    const db = openDatabase(':memory:');
    seed(db);
    expect(new ConfigTrustRepo(db).get('ws_1')).toBeUndefined();
  });

  test('upsert then get round-trips', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const repo = new ConfigTrustRepo(db);
    repo.upsert({ workspaceId: 'ws_1', testCommandHash: 'abc123', trustedAt: '2026-01-01T00:00:00.000Z' });

    expect(repo.get('ws_1')).toEqual({
      workspaceId: 'ws_1', testCommandHash: 'abc123', trustedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  test('a second upsert for the same workspace replaces the hash, not adds a row', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const repo = new ConfigTrustRepo(db);
    repo.upsert({ workspaceId: 'ws_1', testCommandHash: 'old', trustedAt: 't1' });
    repo.upsert({ workspaceId: 'ws_1', testCommandHash: 'new', trustedAt: 't2' });

    expect(repo.get('ws_1')).toEqual({ workspaceId: 'ws_1', testCommandHash: 'new', trustedAt: 't2' });
  });

  test('clear removes the row', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const repo = new ConfigTrustRepo(db);
    repo.upsert({ workspaceId: 'ws_1', testCommandHash: 'abc123', trustedAt: 't1' });
    repo.clear('ws_1');

    expect(repo.get('ws_1')).toBeUndefined();
  });
});
