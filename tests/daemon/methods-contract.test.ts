import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { ContractService } from '../../src/radar/contracts.js';
import { initGrammars } from '../../src/radar/grammars.js';

beforeAll(async () => {
  await initGrammars();
});

async function tempDirWithFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cw-contract-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src/auth.ts'), content);
  return dir;
}

describe('contract.declare RPC', () => {
  test('computes sig_hash from the OWNER SESSION\'s own worktree, not the main checkout', async () => {
    // The main checkout's copy of the file — deliberately DIFFERENT from
    // what the declaring session has in its own worktree, the normal case:
    // you declare a contract on work you are already doing.
    const mainRoot = await tempDirWithFile(
      'export function login(user: string): boolean {\n  return true;\n}\n',
    );
    const ownerWorktree = await tempDirWithFile(
      'export function login(user: string, token: string): boolean {\n  return true;\n}\n',
    );

    try {
      const db = openDatabase(':memory:');
      new WorkspaceRepo(db).insert({
        id: 'ws_1', name: 'w', rootPath: mainRoot, createdAt: 'now',
        defaultIsolation: 'worktree', safeModeTier: 'T1',
      });
      new SessionRepo(db).insert({
        id: 's_owner', workspaceId: 'ws_1', name: 's_owner', agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: ownerWorktree, branch: 'cw/s_owner', createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null, enforcementTier: 'T3', pid: null,
      });

      const methods = buildMethods(db, mainRoot);
      const result = (await methods['contract.declare']!(
        { workspaceId: 'ws_1', sessionId: 's_owner', symbolFqn: 'src/auth.ts#login' },
        { notify: () => undefined, onClose: () => undefined },
      )) as { id: string; symbolFqn: string; sigHash: string };

      // Reference hashes, computed directly from each copy's actual content
      // via the same `ContractService` logic — proves which view the RPC
      // handler actually resolved its source from.
      const ref = new ContractService(db);
      const fromWorktree = ref.declareFromSource(
        { workspaceId: 'ws_1', ownerSession: 's_owner', symbolFqn: 'src/auth-worktree.ts#login' },
        'export function login(user: string, token: string): boolean {\n  return true;\n}\n',
      );
      const fromMainCheckout = ref.declareFromSource(
        { workspaceId: 'ws_1', ownerSession: 's_owner', symbolFqn: 'src/auth-main.ts#login' },
        'export function login(user: string): boolean {\n  return true;\n}\n',
      );

      expect(result.sigHash).toBe(fromWorktree.sigHash);
      expect(result.sigHash).not.toBe(fromMainCheckout.sigHash);
    } finally {
      await rm(mainRoot, { recursive: true, force: true });
      await rm(ownerWorktree, { recursive: true, force: true });
    }
  });

  test('rejects a symbolFqn path that escapes the owner session\'s worktree', async () => {
    const mainRoot = await tempDirWithFile('export function login(): boolean { return true; }\n');
    const ownerWorktree = await tempDirWithFile('export function login(): boolean { return true; }\n');

    try {
      const db = openDatabase(':memory:');
      new WorkspaceRepo(db).insert({
        id: 'ws_1', name: 'w', rootPath: mainRoot, createdAt: 'now',
        defaultIsolation: 'worktree', safeModeTier: 'T1',
      });
      new SessionRepo(db).insert({
        id: 's_owner', workspaceId: 'ws_1', name: 's_owner', agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: ownerWorktree, branch: 'cw/s_owner', createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null, enforcementTier: 'T3', pid: null,
      });

      const methods = buildMethods(db, mainRoot);
      expect(() =>
        methods['contract.declare']!(
          { workspaceId: 'ws_1', sessionId: 's_owner', symbolFqn: '../../../etc/passwd#login' },
          { notify: () => undefined, onClose: () => undefined },
        ),
      ).toThrowError(expect.objectContaining({ code: 'PATH_ESCAPE' }) as unknown as Error);
    } finally {
      await rm(mainRoot, { recursive: true, force: true });
      await rm(ownerWorktree, { recursive: true, force: true });
    }
  });
});
