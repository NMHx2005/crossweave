import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { $ } from 'bun';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceManager } from '../../src/domain/workspace.js';
import { SessionManager } from '../../src/domain/session.js';
import { EventLedger } from '../../src/domain/ledger.js';
import { makeGitFixture, commitFile, type GitFixture } from '../helpers/git-fixture.js';

let fx: GitFixture;
let db: Database;
let sessions: SessionManager;
let ledger: EventLedger;
let workspaceId: string;

beforeEach(async () => {
  fx = await makeGitFixture();
  db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
  workspaceId = new WorkspaceManager(db).init(fx.root).id;
  sessions = new SessionManager(db);
  ledger = new EventLedger(db, fx.root);
});

afterEach(async () => {
  db.close();
  await fx.cleanup();
});

describe('EventLedger', () => {
  it('attributes a committed line to the session whose branch made the commit', async () => {
    const session = await sessions.create({ workspaceId, name: 'auth', agent: 'claude', worktree: true });
    const worktreePath = session.worktreePath;
    if (worktreePath === null) throw new Error('expected a worktree');
    await commitFile(worktreePath, 'auth.ts', 'export const x = 1;\n', 'add auth.ts');

    const result = ledger.blame(workspaceId, 'auth.ts', 1);
    expect(result?.sessionId).toBe(session.id);
    expect(result?.sessionName).toBe('auth');
  }, 30_000);

  it('attributes to the correct session when two sessions have each committed', async () => {
    const a = await sessions.create({ workspaceId, name: 'a', agent: 'claude', worktree: true });
    const b = await sessions.create({ workspaceId, name: 'b', agent: 'claude', worktree: true });
    if (a.worktreePath === null || b.worktreePath === null) throw new Error('expected worktrees');
    await commitFile(a.worktreePath, 'a.ts', 'export const a = 1;\n', 'a commit');
    await commitFile(b.worktreePath, 'b.ts', 'export const b = 1;\n', 'b commit');

    expect(ledger.blame(workspaceId, 'a.ts', 1)?.sessionId).toBe(a.id);
    expect(ledger.blame(workspaceId, 'b.ts', 1)?.sessionId).toBe(b.id);
    // README.md is on the fixture's shared init commit, inherited by both branches
    // at fork time — neither session authored it. Using `base..branch` (not each
    // branch's full history) must exclude it from both sessions' known commits.
    expect(ledger.blame(workspaceId, 'README.md', 1)).toBeUndefined();
  }, 30_000);

  it('attributes an edit to an existing base-branch file to the session that made it', async () => {
    // Reproduces the exact scenario blame() must not give up on: a file that
    // already exists on the base branch, later edited by a session on its own
    // branch. The first revision tried (base) DOES yield a real commit hash for
    // this line — just not one authored by any tracked session — so blame() must
    // keep trying the session's branch rather than returning undefined as soon as
    // the base branch produces any hash at all.
    await commitFile(
      fx.root,
      'app.ts',
      'export const one = 1;\nexport const two = 2;\nexport const three = 3;\n',
      'add app.ts',
    );

    const session = await sessions.create({ workspaceId, name: 'a', agent: 'claude', worktree: true });
    if (session.worktreePath === null) throw new Error('expected a worktree');
    await commitFile(
      session.worktreePath,
      'app.ts',
      'export const one = 1;\nexport const two = 22;\nexport const three = 3;\n',
      'edit line two',
    );

    const result = ledger.blame(workspaceId, 'app.ts', 2);
    expect(result?.sessionId).toBe(session.id);
  }, 30_000);

  it('does not attribute a human commit when the project root moves to another branch', async () => {
    // The user switching branches in their OWN checkout while agents work in
    // worktrees is ordinary. Deriving the attribution boundary from whatever is
    // checked out AT BLAME TIME widened `base..branch` to swallow commits the
    // session never made — and, the event table being append-only, wrote that
    // misattribution permanently. The fork point captured at creation is immune.
    await $`git branch old-release`.cwd(fx.root).quiet();
    const humanHash = await commitFile(fx.root, 'human.ts', 'export const human = 1;\n', 'human work');

    const session = await sessions.create({ workspaceId, name: 'a', agent: 'claude', worktree: true });
    if (session.worktreePath === null) throw new Error('expected a worktree');
    await commitFile(session.worktreePath, 'agent.ts', 'export const agent = 1;\n', 'agent work');

    // `human.ts` is not on old-release, so blame falls through to the session's own
    // branch, where it exists purely because the session forked after that commit.
    await $`git checkout -q old-release`.cwd(fx.root).quiet();

    expect(ledger.blame(workspaceId, 'human.ts', 1)).toBeUndefined();
    const agent = ledger.blame(workspaceId, 'agent.ts', 1);
    expect(agent?.sessionId).toBe(session.id);

    const { EventRepo } = await import('../../src/db/repositories/event.js');
    const attributed = new EventRepo(db)
      .listBySession(session.id)
      .filter((e) => e.kind === 'commit.made')
      .map((e) => (JSON.parse(e.payload) as { commitHash: string }).commitHash);
    expect(attributed).not.toContain(humanHash);
  }, 30_000);

  it('returns undefined for an uncommitted line, honestly, rather than guessing', async () => {
    const session = await sessions.create({ workspaceId, name: 'auth', agent: 'claude', worktree: true });
    if (session.worktreePath === null) throw new Error('expected a worktree');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(session.worktreePath, 'scratch.ts'), 'export const y = 1;\n');

    expect(ledger.blame(workspaceId, 'scratch.ts', 1)).toBeUndefined();
  }, 30_000);

  it('returns undefined for a file that does not exist', () => {
    expect(ledger.blame(workspaceId, 'nope.ts', 1)).toBeUndefined();
  });

  it('is idempotent — calling blame twice does not duplicate commit.made events', async () => {
    const session = await sessions.create({ workspaceId, name: 'auth', agent: 'claude', worktree: true });
    if (session.worktreePath === null) throw new Error('expected a worktree');
    await commitFile(session.worktreePath, 'auth.ts', 'export const x = 1;\n', 'add auth.ts');

    ledger.blame(workspaceId, 'auth.ts', 1);
    ledger.blame(workspaceId, 'auth.ts', 1);

    const { EventRepo } = await import('../../src/db/repositories/event.js');
    const commitEvents = new EventRepo(db).listBySession(session.id).filter((e) => e.kind === 'commit.made');
    expect(commitEvents).toHaveLength(1);
  }, 30_000);
});
