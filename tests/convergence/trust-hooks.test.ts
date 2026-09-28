import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { ConfigTrustRepo } from '../../src/db/repositories/config-trust.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { hashHooks, hashTestCommand, isHooksTrusted, isTestCommandTrusted } from '../../src/convergence/trust.js';

function seed(db: ReturnType<typeof openDatabase>): void {
  new WorkspaceRepo(db).insert({
    id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
    defaultIsolation: 'worktree', safeModeTier: 'T1',
  });
}

describe('hashHooks', () => {
  test('is stable for the same hooks, independent of key order', () => {
    expect(hashHooks({ sessionSetup: 'a', sessionTeardown: 'b' }))
      .toBe(hashHooks({ sessionTeardown: 'b', sessionSetup: 'a' }));
  });

  test('changes on any edit, including adding or dropping a side', () => {
    expect(hashHooks({ sessionSetup: 'a' })).not.toBe(hashHooks({ sessionSetup: 'a ' }));
    expect(hashHooks({ sessionSetup: 'a' })).not.toBe(hashHooks({ sessionSetup: 'a', sessionTeardown: 'b' }));
  });
});

describe('isHooksTrusted', () => {
  test('false with no row, true after setHooks, false once edited', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const repo = new ConfigTrustRepo(db);
    expect(isHooksTrusted({ sessionSetup: 'bun install' }, repo, 'ws_1')).toBe(false);
    repo.setHooks('ws_1', hashHooks({ sessionSetup: 'bun install' }), 'now');
    expect(isHooksTrusted({ sessionSetup: 'bun install' }, repo, 'ws_1')).toBe(true);
    expect(isHooksTrusted({ sessionSetup: 'bun install && rm -rf /' }, repo, 'ws_1')).toBe(false);
  });

  test('trusting the test command does not arm the hooks', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const repo = new ConfigTrustRepo(db);
    repo.upsert({ workspaceId: 'ws_1', testCommandHash: hashTestCommand('npm test'), trustedAt: 'now' });
    expect(isHooksTrusted({ sessionSetup: 'bun install' }, repo, 'ws_1')).toBe(false);
  });

  test('setHooks preserves an existing test-command trust, and upsert preserves hooks', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const repo = new ConfigTrustRepo(db);
    repo.upsert({ workspaceId: 'ws_1', testCommandHash: hashTestCommand('npm test'), trustedAt: 't1' });
    repo.setHooks('ws_1', hashHooks({ sessionSetup: 'bun install' }), 't2');
    expect(isHooksTrusted({ sessionSetup: 'bun install' }, repo, 'ws_1')).toBe(true);
    expect(isTestCommandTrusted('npm test', repo, 'ws_1')).toBe(true);

    // And the other order: a later test-command trust must not clear the hooks.
    repo.upsert({ workspaceId: 'ws_1', testCommandHash: hashTestCommand('npm test'), trustedAt: 't3' });
    expect(isHooksTrusted({ sessionSetup: 'bun install' }, repo, 'ws_1')).toBe(true);
  });
});
