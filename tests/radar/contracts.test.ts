import { beforeAll, describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { FileClaimRepo } from '../../src/db/repositories/file-claim.js';
import { ContractRepo } from '../../src/db/repositories/contract.js';
import { MessageBus } from '../../src/domain/bus.js';
import { SessionManager } from '../../src/domain/session.js';
import { ContractService } from '../../src/radar/contracts.js';
import { initGrammars } from '../../src/radar/grammars.js';

beforeAll(async () => { await initGrammars(); });

function seed(db: ReturnType<typeof openDatabase>) {
  new WorkspaceRepo(db).insert({
    id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
    defaultIsolation: 'worktree', safeModeTier: 'T1',
  });
  const sessions = new SessionRepo(db);
  for (const id of ['s_owner', 's_user']) {
    sessions.insert({
      id, workspaceId: 'ws_1', name: id, agentKind: 'claude', adapter: 'claude',
      status: 'running', worktreePath: `/tmp/w/${id}`, branch: `cw/${id}`, createdAt: 'now',
      lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
    });
  }
}

describe('ContractService', () => {
  test('declare computes a sig_hash from the symbol\'s current public shape', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const service = new ContractService(db);
    const contract = service.declareFromSource(
      { workspaceId: 'ws_1', ownerSession: 's_owner', symbolFqn: 'src/auth.ts#login' },
      'export function login(user: string): boolean {\n  return true;\n}\n',
    );
    expect(contract.symbolFqn).toBe('src/auth.ts#login');
    expect(contract.sigHash).toBeTruthy();
  });

  test('a body-only change to the same signature does not change sig_hash', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const service = new ContractService(db);
    const a = service.declareFromSource(
      { workspaceId: 'ws_1', ownerSession: 's_owner', symbolFqn: 'src/auth.ts#login' },
      'export function login(user: string): boolean {\n  return true;\n}\n',
    );
    const repo = new ContractRepo(db);
    const before = repo.findByFqn('ws_1', 'src/auth.ts#login');
    expect(before?.sigHash).toBe(a.sigHash);
  });

  test('the caller is responsible for calling checkAndNotify after a real re-index; a signature-changing edit fires a system message to subscribers', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const service = new ContractService(db);
    service.declareFromSource(
      { workspaceId: 'ws_1', ownerSession: 's_owner', symbolFqn: 'src/auth.ts#login' },
      'export function login(user: string): boolean {\n  return true;\n}\n',
    );

    const bus = new MessageBus(db, new SessionManager(db));
    new ContractRepo(db).addSubscriber(
      new ContractRepo(db).findByFqn('ws_1', 'src/auth.ts#login')!.id, 's_user', 'now',
    );

    service.checkAndNotify(
      'ws_1', 'src/auth.ts',
      'export function login(user: string, token: string): boolean {\n  return true;\n}\n',
      bus,
    );

    const inbox = bus.inbox('ws_1', 's_user');
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.trust).toBe('system');
  });
});
