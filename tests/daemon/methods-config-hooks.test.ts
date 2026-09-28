import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';

const ctx = { notify: () => undefined, onClose: () => undefined };

function seed(db: ReturnType<typeof openDatabase>): void {
  new WorkspaceRepo(db).insert({
    id: 'ws_1', name: 'w', rootPath: '/tmp/demo', createdAt: 'now',
    defaultIsolation: 'worktree', safeModeTier: 'T1',
  });
}

const config = {
  ...DEFAULT_CONFIG,
  converge: { ...DEFAULT_CONFIG.converge, testCommand: 'npm test' },
  hooks: { sessionSetup: 'bun install' },
};

interface Status {
  testCommand: string | null;
  trusted: boolean;
  hooks: { sessionSetup: string | null; sessionTeardown: string | null; trusted: boolean };
}

describe('config.trust / config.status with hooks', () => {
  test('the two trusts are separate, and untrust revokes both', async () => {
    const db = openDatabase(':memory:');
    seed(db);
    const methods = buildMethods(db, '/tmp/demo', undefined, config);
    const status = async (): Promise<Status> => (await methods['config.status']!({ workspaceId: 'ws_1' }, ctx)) as Status;

    // Trust the test command: the hooks stay unarmed.
    expect(await methods['config.trust']!({ workspaceId: 'ws_1' }, ctx)).toMatchObject({ target: 'testCommand' });
    expect((await status()).trusted).toBe(true);
    expect((await status()).hooks.trusted).toBe(false);

    // Trust the hooks: the test-command trust survives.
    expect(await methods['config.trust']!({ workspaceId: 'ws_1', target: 'hooks' }, ctx)).toMatchObject({ target: 'hooks' });
    const after = await status();
    expect(after.hooks).toEqual({ sessionSetup: 'bun install', sessionTeardown: null, trusted: true });
    expect(after.trusted).toBe(true);

    // untrust is one switch for both.
    await methods['config.untrust']!({ workspaceId: 'ws_1' }, ctx);
    const cleared = await status();
    expect(cleared.trusted).toBe(false);
    expect(cleared.hooks.trusted).toBe(false);
    db.close();
  });

  test('trusting hooks with none configured is a clear error, and an unknown target is refused', async () => {
    const db = openDatabase(':memory:');
    seed(db);
    const noHooks = { ...DEFAULT_CONFIG, converge: { ...DEFAULT_CONFIG.converge, testCommand: 'npm test' } };
    const methods = buildMethods(db, '/tmp/demo', undefined, noHooks);
    try {
      await methods['config.trust']!({ workspaceId: 'ws_1', target: 'hooks' }, ctx);
      throw new Error('expected CONFIG_NO_HOOKS');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('CONFIG_NO_HOOKS');
    }
    try {
      await methods['config.trust']!({ workspaceId: 'ws_1', target: 'nonsense' }, ctx);
      throw new Error('expected INVALID_PARAMS');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('INVALID_PARAMS');
    }
    db.close();
  });
});
