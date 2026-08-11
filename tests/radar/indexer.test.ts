import { beforeAll, describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { FileClaimRepo } from '../../src/db/repositories/file-claim.js';
import { RadarIndexer } from '../../src/radar/indexer.js';
import { initGrammars } from '../../src/radar/grammars.js';
import { makeGitFixture, commitFile, type GitFixture } from '../helpers/git-fixture.js';

beforeAll(async () => {
  await initGrammars();
});

async function setup(fixture: GitFixture) {
  const db = openDatabase(':memory:');
  new WorkspaceRepo(db).insert({
    id: 'ws_1', name: 'w', rootPath: fixture.root, createdAt: 'now',
    defaultIsolation: 'worktree', safeModeTier: 'T1',
  });
  new SessionRepo(db).insert({
    id: 's_1', workspaceId: 'ws_1', name: 'a', agentKind: 'claude', adapter: 'claude',
    status: 'idle', worktreePath: fixture.root, branch: 'main', createdAt: 'now',
    lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
  });
  const claims = new FileClaimRepo(db);
  return { db, claims, indexer: new RadarIndexer(db) };
}

describe('RadarIndexer.reindexSession', () => {
  test('a genuinely changed function produces a claim', async () => {
    const fixture = await makeGitFixture();
    try {
      const forkPoint = (await commitFile(
        fixture.root, 'src/greet.ts', 'export function greet() {\n  return 1;\n}\n', 'base',
      ));
      const { claims, indexer } = await setup(fixture);

      await commitFile(fixture.root, 'src/greet.ts', 'export function greet() {\n  return 2;\n}\n', 'wip');

      await indexer.reindexSession({ id: 's_1', workspaceId: 'ws_1', worktreePath: fixture.root, forkPoint });

      const rows = claims.listBySession('s_1');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.path).toBe('src/greet.ts');
      expect(rows[0]?.symbol).toBe('greet');
      expect(rows[0]?.kind).toBe('function');
    } finally {
      await fixture.cleanup();
    }
  });

  test('a whitespace-only change produces no claim', async () => {
    const fixture = await makeGitFixture();
    try {
      const forkPoint = await commitFile(
        fixture.root, 'src/greet.ts', 'export function greet() {\n  return 1;\n}\n', 'base',
      );
      const { claims, indexer } = await setup(fixture);

      await commitFile(fixture.root, 'src/greet.ts', 'export function greet() {\n    return 1;\n}\n', 'wip');

      await indexer.reindexSession({ id: 's_1', workspaceId: 'ws_1', worktreePath: fixture.root, forkPoint });
      expect(claims.listBySession('s_1')).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test('reverting to the merge-base content removes a previously written claim', async () => {
    const fixture = await makeGitFixture();
    try {
      const original = 'export function greet() {\n  return 1;\n}\n';
      const forkPoint = await commitFile(fixture.root, 'src/greet.ts', original, 'base');
      const { claims, indexer } = await setup(fixture);

      await commitFile(fixture.root, 'src/greet.ts', 'export function greet() {\n  return 2;\n}\n', 'wip');
      await indexer.reindexSession({ id: 's_1', workspaceId: 'ws_1', worktreePath: fixture.root, forkPoint });
      expect(claims.listBySession('s_1')).toHaveLength(1);

      await commitFile(fixture.root, 'src/greet.ts', original, 'revert');
      await indexer.reindexSession({ id: 's_1', workspaceId: 'ws_1', worktreePath: fixture.root, forkPoint });
      expect(claims.listBySession('s_1')).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test('an unparseable/unsupported file gets a file-level claim', async () => {
    const fixture = await makeGitFixture();
    try {
      const forkPoint = await commitFile(fixture.root, 'README.md', '# a\n', 'base');
      const { claims, indexer } = await setup(fixture);

      await commitFile(fixture.root, 'README.md', '# a\n\nmore text\n', 'wip');
      await indexer.reindexSession({ id: 's_1', workspaceId: 'ws_1', worktreePath: fixture.root, forkPoint });

      const rows = claims.listBySession('s_1');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.symbol).toBeNull();
      expect(rows[0]?.kind).toBe('file');
    } finally {
      await fixture.cleanup();
    }
  });

  test('advancing the fork point to include the change clears the now-stale claim', async () => {
    const fixture = await makeGitFixture();
    try {
      const forkPoint = await commitFile(
        fixture.root, 'src/greet.ts', 'export function greet() {\n  return 1;\n}\n', 'base',
      );
      const { claims, indexer } = await setup(fixture);

      const laterCommit = await commitFile(
        fixture.root, 'src/greet.ts', 'export function greet() {\n  return 2;\n}\n', 'wip',
      );
      await indexer.reindexSession({ id: 's_1', workspaceId: 'ws_1', worktreePath: fixture.root, forkPoint });
      expect(claims.listBySession('s_1')).toHaveLength(1);

      // Re-running with the fork point advanced to the commit that already
      // contains the change makes the diff against that new base empty —
      // the same reconciliation behavior a real "session committed and its
      // working tree is now clean relative to its own latest state" moment
      // would trigger, without needing M4's `cw land` to exist yet.
      await indexer.reindexSession({
        id: 's_1', workspaceId: 'ws_1', worktreePath: fixture.root, forkPoint: laterCommit,
      });
      expect(claims.listBySession('s_1')).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });
});
