import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { ConfigTrustRepo } from '../../src/db/repositories/config-trust.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { hashTestCommand, isTestCommandTrusted } from '../../src/convergence/trust.js';

function seed(db: ReturnType<typeof openDatabase>) {
  new WorkspaceRepo(db).insert({
    id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
    defaultIsolation: 'worktree', safeModeTier: 'T1',
  });
}

describe('hashTestCommand', () => {
  test('is deterministic for the same string', () => {
    expect(hashTestCommand('npm test')).toBe(hashTestCommand('npm test'));
  });

  test('differs for different strings', () => {
    expect(hashTestCommand('npm test')).not.toBe(hashTestCommand('npm test '));
  });
});

describe('isTestCommandTrusted', () => {
  test('false when no trust row exists for the workspace', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const configTrust = new ConfigTrustRepo(db);
    expect(isTestCommandTrusted('npm test', configTrust, 'ws_1')).toBe(false);
  });

  test('true once the exact command string has been trusted', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const configTrust = new ConfigTrustRepo(db);
    configTrust.upsert({ workspaceId: 'ws_1', testCommandHash: hashTestCommand('npm test'), trustedAt: 'now' });
    expect(isTestCommandTrusted('npm test', configTrust, 'ws_1')).toBe(true);
  });

  test('false once the trusted string is edited, even slightly — trust does not carry over', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const configTrust = new ConfigTrustRepo(db);
    configTrust.upsert({ workspaceId: 'ws_1', testCommandHash: hashTestCommand('npm test'), trustedAt: 'now' });
    expect(isTestCommandTrusted('npm test && rm -rf /', configTrust, 'ws_1')).toBe(false);
  });

  test('a trust row for a different workspace does not leak across workspaces', () => {
    const db = openDatabase(':memory:');
    seed(db);
    new WorkspaceRepo(db).insert({
      id: 'ws_2', name: 'w2', rootPath: '/tmp/w2', createdAt: 'now',
      defaultIsolation: 'worktree', safeModeTier: 'T1',
    });
    const configTrust = new ConfigTrustRepo(db);
    configTrust.upsert({ workspaceId: 'ws_1', testCommandHash: hashTestCommand('npm test'), trustedAt: 'now' });
    expect(isTestCommandTrusted('npm test', configTrust, 'ws_2')).toBe(false);
  });
});
