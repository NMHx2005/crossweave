import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { ContractRepo, type ContractRow } from '../../src/db/repositories/contract.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';

function seed(db: ReturnType<typeof openDatabase>) {
  const workspaces = new WorkspaceRepo(db);
  const sessions = new SessionRepo(db);
  workspaces.insert({
    id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
    defaultIsolation: 'worktree', safeModeTier: 'T1',
  });
  for (const id of ['s_1', 's_2']) {
    sessions.insert({
      id, workspaceId: 'ws_1', name: id, agentKind: 'claude', adapter: 'claude',
      status: 'idle', worktreePath: `/tmp/w/${id}`, branch: `cw/${id}`, createdAt: 'now',
      lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
    });
  }
}

function row(overrides: Partial<ContractRow> = {}): ContractRow {
  return {
    id: 'ct_1', workspaceId: 'ws_1', ownerSession: 's_1',
    symbolFqn: 'src/auth.ts#AuthService', sigHash: 'sig1',
    declaredAt: 'now', stableBy: null, ...overrides,
  };
}

describe('ContractRepo', () => {
  test('insert then findByFqn round-trips', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const repo = new ContractRepo(db);
    repo.insert(row());
    expect(repo.findByFqn('ws_1', 'src/auth.ts#AuthService')?.sigHash).toBe('sig1');
  });

  test('updateSigHash changes only sigHash', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const repo = new ContractRepo(db);
    repo.insert(row());
    repo.updateSigHash('ct_1', 'sig2');
    const found = repo.findByFqn('ws_1', 'src/auth.ts#AuthService');
    expect(found?.sigHash).toBe('sig2');
    expect(found?.declaredAt).toBe('now');
  });

  test('addSubscriber is idempotent and listSubscribers reflects it', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const repo = new ContractRepo(db);
    repo.insert(row());
    repo.addSubscriber('ct_1', 's_2', 'now');
    repo.addSubscriber('ct_1', 's_2', 'later'); // re-subscribing must not duplicate or error
    expect(repo.listSubscribers('ct_1')).toEqual(['s_2']);
  });
});
