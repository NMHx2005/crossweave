import { beforeAll, describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
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
      lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null, enforcementTier: 'T3', pid: null,
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
    const b = service.declareFromSource(
      { workspaceId: 'ws_1', ownerSession: 's_owner', symbolFqn: 'src/auth.ts#login' },
      'export function login(user: string): boolean {\n  return false;\n}\n',
    );
    expect(b.sigHash).toBe(a.sigHash);
  });

  test('a body-only change to a Python function does not change sig_hash', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const service = new ContractService(db);
    const a = service.declareFromSource(
      { workspaceId: 'ws_1', ownerSession: 's_owner', symbolFqn: 'src/auth.py#login' },
      'def login(user):\n    return True\n',
    );
    const b = service.declareFromSource(
      { workspaceId: 'ws_1', ownerSession: 's_owner', symbolFqn: 'src/auth.py#login' },
      'def login(user):\n    return False\n',
    );
    expect(b.sigHash).toBe(a.sigHash);
  });

  test('a destructured-param function fires when its return type changes, even though a `{` appears before the body', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const service = new ContractService(db);
    const a = service.declareFromSource(
      { workspaceId: 'ws_1', ownerSession: 's_owner', symbolFqn: 'src/auth.ts#login' },
      'export function login({ user }: Creds): boolean {\n  return true;\n}\n',
    );
    const b = service.declareFromSource(
      { workspaceId: 'ws_1', ownerSession: 's_owner', symbolFqn: 'src/auth.ts#login' },
      'export function login({ user }: Creds): string {\n  return "true";\n}\n',
    );
    expect(b.sigHash).not.toBe(a.sigHash);
  });

  test('autoSubscribeForPath subscribes a session with a claim on the same file, so a later signature change reaches it', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const service = new ContractService(db);
    service.declareFromSource(
      { workspaceId: 'ws_1', ownerSession: 's_owner', symbolFqn: 'src/auth.ts#login' },
      'export function login(user: string): boolean {\n  return true;\n}\n',
    );

    service.autoSubscribeForPath('ws_1', 's_user', 'src/auth.ts');
    const contractId = new ContractRepo(db).findByFqn('ws_1', 'src/auth.ts#login')!.id;
    expect(new ContractRepo(db).listSubscribers(contractId)).toContain('s_user');

    const bus = new MessageBus(db, new SessionManager(db));
    service.checkAndNotify(
      'ws_1', 'src/auth.ts',
      'export function login(user: string, token: string): boolean {\n  return true;\n}\n',
      bus, 's_owner',
    );

    const inbox = bus.inbox('ws_1', 's_user');
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.trust).toBe('system');
  });

  test('autoSubscribeForPath does not subscribe a contract\'s own owner to its own contract', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const service = new ContractService(db);
    const contract = service.declareFromSource(
      { workspaceId: 'ws_1', ownerSession: 's_owner', symbolFqn: 'src/auth.ts#login' },
      'export function login(user: string): boolean {\n  return true;\n}\n',
    );

    // The owner also has a claim on the same file — the normal case, since
    // it declared a contract on work it is doing.
    service.autoSubscribeForPath('ws_1', 's_owner', 'src/auth.ts');

    expect(new ContractRepo(db).listSubscribers(contract.id)).not.toContain('s_owner');
  });

  test('only the contract owner\'s own tick may update sig_hash — a subscriber\'s divergent worktree view is not authoritative', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const service = new ContractService(db);
    const declared = service.declareFromSource(
      { workspaceId: 'ws_1', ownerSession: 's_owner', symbolFqn: 'src/auth.ts#login' },
      'export function login(user: string): boolean {\n  return true;\n}\n',
    );
    new ContractRepo(db).addSubscriber(declared.id, 's_user', 'now');
    const bus = new MessageBus(db, new SessionManager(db));

    // Session B's own tick sees a DIFFERENT (but not actually re-edited by
    // the owner) view of the file — e.g. its own worktree hasn't picked up
    // the owner's change yet. This must be a no-op: no hash flap, no
    // spurious notification.
    service.checkAndNotify(
      'ws_1', 'src/auth.ts',
      'export function login(user: string, extra: number): boolean {\n  return true;\n}\n',
      bus, 's_user',
    );
    expect(new ContractRepo(db).findByFqn('ws_1', 'src/auth.ts#login')?.sigHash).toBe(declared.sigHash);
    expect(bus.inbox('ws_1', 's_user')).toHaveLength(0);

    // The owner's own tick, with a genuinely changed signature, DOES update
    // the hash and DOES notify.
    service.checkAndNotify(
      'ws_1', 'src/auth.ts',
      'export function login(user: string, token: string): boolean {\n  return true;\n}\n',
      bus, 's_owner',
    );
    const after = new ContractRepo(db).findByFqn('ws_1', 'src/auth.ts#login');
    expect(after?.sigHash).not.toBe(declared.sigHash);
    const inbox = bus.inbox('ws_1', 's_user');
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.trust).toBe('system');
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
      bus, 's_owner',
    );

    const inbox = bus.inbox('ws_1', 's_user');
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.trust).toBe('system');
  });
});
