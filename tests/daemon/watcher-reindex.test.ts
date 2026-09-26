import { describe, expect, test } from 'bun:test';
import { $ } from 'bun';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { FileClaimRepo } from '../../src/db/repositories/file-claim.js';
import { MessageBus } from '../../src/domain/bus.js';
import { SessionManager } from '../../src/domain/session.js';
import { ContractService } from '../../src/radar/contracts.js';
import { RadarWatcherRegistry } from '../../src/daemon/watcher.js';
import { commitFile, makeGitFixture, type GitFixture } from '../helpers/git-fixture.js';

/**
 * The PostToolUse fast path (spec §3.4). Deliberately NOT a test of `fs.watch` event
 * delivery — this repo's own constraint (see RadarWatcherRegistry's header): a
 * sandboxed shell may drop those notifications, which would make the assertion flaky
 * for a reason unrelated to the code. Everything here rides on `reindexNow`, which is
 * the part the hook actually calls.
 */
let fixture: GitFixture;

async function seeded() {
  fixture = await makeGitFixture();
  const db = openDatabase(':memory:');
  new WorkspaceRepo(db).insert({
    id: 'ws_1', name: 'w', rootPath: fixture.root, createdAt: 'now',
    defaultIsolation: 'worktree', safeModeTier: 'T2',
  });
  new SessionRepo(db).insert({
    id: 's_1', workspaceId: 'ws_1', name: 's_1', agentKind: 'claude', adapter: 'claude',
    status: 'running', worktreePath: fixture.root, branch: 'cw/s_1', createdAt: 'now',
    lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null,
    enforcementTier: 'T2', pid: null, launchArgs: null,
  });
  return db;
}

function registryFor(db: ReturnType<typeof openDatabase>): RadarWatcherRegistry {
  const managers = new SessionManager(db);
  return new RadarWatcherRegistry(
    db, new MessageBus(db, managers), new ContractService(db),
    undefined, undefined, undefined,
  );
}

describe('RadarWatcherRegistry.reindexNow', () => {
  test('a session with no watcher reports false — there is no fork point to diff against', async () => {
    const db = await seeded();
    const registry = registryFor(db);
    expect(await registry.reindexNow('s_none')).toBe(false);
    await fixture.cleanup();
    db.close();
  });

  test('a registered session is reindexed on demand, no debounce wait', async () => {
    const db = await seeded();
    // A committed .ts file, not the fixture's README: a Markdown-only change is
    // normalised away by the indexer's comment-stripping hash (every line of it looks
    // like a comment), which is a separate, pre-existing quirk this test is not about.
    const forkPoint = await commitFile(
      fixture.root, 'src/greet.ts', 'export function greet() {\n  return 1;\n}\n', 'base',
    );
    const registry = registryFor(db);
    registry.start({ id: 's_1', workspaceId: 'ws_1', worktreePath: fixture.root, forkPoint });

    await commitFile(fixture.root, 'src/greet.ts', 'export function greet() {\n  return 2;\n}\n', 'wip');

    const reindexed = await registry.reindexNow('s_1', ['src/greet.ts']);
    expect(reindexed).toBe(true);

    const claims = new FileClaimRepo(db).listBySession('s_1');
    expect(claims.map((c) => c.path)).toContain('src/greet.ts');
    expect(claims[0]?.symbol).toBe('greet');
    registry.stopAll();
    await fixture.cleanup();
    db.close();
  });
});
