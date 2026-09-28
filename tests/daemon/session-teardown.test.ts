import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { ConfigTrustRepo } from '../../src/db/repositories/config-trust.js';
import { WorkspaceManager } from '../../src/domain/workspace.js';
import { hashHooks } from '../../src/convergence/trust.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { makeGitFixture } from '../helpers/git-fixture.js';

const ctx = { notify: () => undefined, onClose: () => undefined };

async function fixtureWithTeardown(markerPath: string, trusted: boolean) {
  const fx = await makeGitFixture();
  const db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
  const ws = new WorkspaceManager(db).init(fx.root);
  const hooks = { sessionTeardown: `touch ${markerPath}` };
  const config = { ...DEFAULT_CONFIG, hooks };
  if (trusted) new ConfigTrustRepo(db).setHooks(ws.id, hashHooks(hooks), 'now');
  const methods = buildMethods(db, fx.root, undefined, config);
  return { fx, db, ws, methods };
}

describe('sessionTeardown', () => {
  test('runs in the worktree before session rm deletes it', async () => {
    const marker = join(process.env.TMPDIR ?? '/tmp', `cw-teardown-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const { fx, db, ws, methods } = await fixtureWithTeardown(marker, true);
    try {
      await methods['session.new']!({ workspaceId: ws.id, name: 'a' }, ctx);
      await methods['session.kill']!({ workspaceId: ws.id, idOrName: 'a' }, ctx); // dead, worktree kept
      const result = (await methods['session.rm']!({ workspaceId: ws.id, idOrName: 'a' }, ctx)) as { warnings: string[] };
      expect(result.warnings).toEqual([]);
      expect(existsSync(marker)).toBe(true);
    } finally {
      db.close();
      await fx.cleanup();
    }
  }, 15_000);

  test('an untrusted teardown is skipped with a warning, and does not run', async () => {
    const marker = join(process.env.TMPDIR ?? '/tmp', `cw-teardown-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const { fx, db, ws, methods } = await fixtureWithTeardown(marker, false);
    try {
      await methods['session.new']!({ workspaceId: ws.id, name: 'a' }, ctx);
      await methods['session.kill']!({ workspaceId: ws.id, idOrName: 'a' }, ctx);
      const result = (await methods['session.rm']!({ workspaceId: ws.id, idOrName: 'a' }, ctx)) as { warnings: string[] };
      expect(result.warnings.join(' ')).toContain('not trusted');
      expect(existsSync(marker)).toBe(false);
    } finally {
      db.close();
      await fx.cleanup();
    }
  }, 15_000);

  test('gc runs the teardown for the sessions it reclaims', async () => {
    const marker = join(process.env.TMPDIR ?? '/tmp', `cw-teardown-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const { fx, db, ws, methods } = await fixtureWithTeardown(marker, true);
    try {
      await methods['session.new']!({ workspaceId: ws.id, name: 'a' }, ctx);
      await methods['session.kill']!({ workspaceId: ws.id, idOrName: 'a' }, ctx);
      const result = (await methods['workspace.gc']!({ id: ws.id }, ctx)) as { removed: string[]; warnings: string[] };
      expect(result.removed).toContain('a');
      expect(result.warnings).toEqual([]);
      expect(existsSync(marker)).toBe(true);
    } finally {
      db.close();
      await fx.cleanup();
    }
  }, 15_000);
});
