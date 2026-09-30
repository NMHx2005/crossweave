import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { CheckRunner } from '../../src/daemon/checks.js';
import { SessionCheckRepo } from '../../src/db/repositories/session-check.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';

function seeded() {
  const db = openDatabase(':memory:');
  new WorkspaceRepo(db).insert({ id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now', defaultIsolation: 'worktree', safeModeTier: 'T1' });
  const sessions = new SessionRepo(db);
  for (const id of ['s_1', 's_2']) {
    sessions.insert({
      id, workspaceId: 'ws_1', name: id, agentKind: 'claude', adapter: 'claude', status: 'idle', worktreePath: null, branch: null,
      createdAt: 'now', lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null,
      enforcementTier: 'T3', pid: null, launchArgs: null,
    });
  }
  return { db, sessions, repo: new SessionCheckRepo(db) };
}
const row = (over = {}) => ({ state: 'fail' as const, at: 10, finishedAt: 20, ms: 10, code: 1, tail: 'boom', changed: 2, ahead: 1, ...over });

describe('SessionCheckRepo', () => {
  test('a saved verdict round-trips, including unknown counts and no tail', () => {
    const { repo } = seeded();
    repo.save('s_1', row());
    repo.save('s_2', row({ state: 'pass', code: 0, tail: undefined, changed: 0, ahead: null }));
    const all = repo.load();
    expect(all.get('s_1')).toEqual(row());
    expect(all.get('s_2')).toEqual({ state: 'pass', at: 10, finishedAt: 20, ms: 10, code: 0, changed: 0, ahead: null });
  });

  test('saving again replaces; remove is idempotent', () => {
    const { repo } = seeded();
    repo.save('s_1', row());
    repo.save('s_1', row({ state: 'pass', code: 0, tail: undefined }));
    expect(repo.load().get('s_1')?.state).toBe('pass');
    repo.remove('s_1');
    repo.remove('s_1');
    expect(repo.load().size).toBe(0);
  });

  test('a verdict goes with its session', () => {
    const { db, repo } = seeded();
    repo.save('s_1', row());
    db.run("DELETE FROM session WHERE id = 's_1'");
    expect(repo.load().size).toBe(0);
  });

  test('a verdict for a session that does not exist is refused, not orphaned', () => {
    const { repo } = seeded();
    expect(() => repo.save('s_nope', row())).toThrow();
  });

  test('a runner over the real table: the verdict survives a "restart" and dies with the session', async () => {
    const { db, repo } = seeded();
    const first = new CheckRunner({ run: async () => ({ code: 1, tail: 'red' }), onChange: () => undefined, store: repo });
    first.start('s_1', 'bun test', '/wt', {}, { changed: 1, ahead: 0 });
    await new Promise((r) => setTimeout(r, 10));
    const second = new CheckRunner({ run: async () => ({ code: 0, tail: '' }), onChange: () => undefined, store: repo });
    expect(second.get('s_1', { changed: 1, ahead: 0 }, null)).toMatchObject({ state: 'fail', tail: 'red', stale: false });
    db.run("DELETE FROM session WHERE id = 's_1'");
    expect(new CheckRunner({ run: async () => ({ code: 0, tail: '' }), onChange: () => undefined, store: repo }).get('s_1', null, null)).toBeUndefined();
  });
});
