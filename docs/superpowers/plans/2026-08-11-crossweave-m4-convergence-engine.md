# crossweave M4 — Convergence Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Continuously trial-merge every active session's branch against every
other in the background, surface the resulting conflict graph and a
merge-order recommendation, and give `cw land` / `cw land --all` — the
terminal operation that actually gets a session's work into the base branch.

**Architecture:** A daemon-owned scheduler ticks every 5s, running cheap
pairwise `git merge --no-commit --no-ff` trials in one persistent scratch
worktree (`.crossweave/integration`, holding its own resource lease exactly
like a session) and recording results in an append-only `merge_trial` table.
A conflict graph built from the latest pairwise result per branch pair
drives the merge-order recommendation. `cw land` re-verifies a branch against
the current base fresh (never a cached trial), runs the configured test
command if any, merges to base, and marks the session `landed`.

**Tech Stack:** Bun ≥1.3.5, TypeScript, `bun:sqlite`, `bun test`,
`simple-git`, `citty` — no new dependency.

## Global Constraints

- Runtime dependencies stay exactly `citty`, `simple-git`, `web-tree-sitter`
  — M4 adds none.
- `SCHEMA_VERSION` moves from 5 to 6. Migrations remain lists of single
  statements, matching every existing entry in `src/db/schema.ts`.
- Every new RPC method in `src/daemon/methods.ts` uses the existing
  `str`/`optionalStr`/`bool`/`num` param helpers and throws `CrossweaveError`
  with an `UPPER_SNAKE_CASE` code on invalid input.
- The scratch integration worktree lives at `.crossweave/integration` (NOT
  under `.crossweave/worktrees/`, which is reserved for real sessions), on
  branch `cw/integration`. It is backed by a real `session` row
  (`agentKind: 'integration'`) so `lease.session_id`'s foreign key has
  something to point at — this row is never returned by `cw session list`,
  never resolvable by `session.resolve`/messaging, and its reserved name
  (`__integration__`) is rejected if a user tries to create a real session
  with it.
- `cw land` is destructive and outward-facing (per the design doc §5.4):
  it always requires `--yes` to proceed past its confirmation gate, using
  this codebase's existing pattern (a client-side `CrossweaveError`
  `CONFIRMATION_REQUIRED` thrown in the CLI command before the RPC call —
  see `src/cli/commands/session.ts`'s `kill`/`rm` commands — never an
  interactive terminal prompt). It never force-pushes and never rewrites
  shared history — every git operation is a local `merge`/`squash`/`rebase`
  against the user's own base branch.
- `merge_trial.result` is `'unverified'`, never `'clean'`, whenever a merge
  succeeded but `converge.testCommand` was unset — no code path may promote
  an unrun test to a passing one.
- The intent-aware auto-resolver and any Context Store "intent" capture
  mechanism are explicitly OUT of scope for this plan (deferred by user
  decision during brainstorming) — do not add either.

---

### Task 1: `merge_trial` schema, `session.landed` event kind, `MergeTrialRepo`

**Files:**
- Modify: `src/db/schema.ts`
- Create: `src/db/repositories/merge-trial.ts`
- Modify: `src/core/ids.ts`
- Modify: `src/db/repositories/event.ts`
- Test: `tests/db/merge-trial-repo.test.ts`

**Interfaces:**
- Produces: `MergeTrialRepo` (`insert(row)`, `listByWorkspace(workspaceId)`),
  `MergeTrialRow` (`id, workspaceId, ts, branches: string[], result, detail:
  string | null`) — Task 3 (trial mechanics' caller) and Task 5 (conflict
  graph) both consume this.

- [ ] **Step 1: Write the migration**

```ts
// Appended to MIGRATIONS in src/db/schema.ts; bump the top-of-file constant first:
export const SCHEMA_VERSION = 6;
```

```ts
  [
    // Convergence Engine (M4): trial-merge history, and the session.landed
    // event kind cw land needs to record its terminal state transition.
    `CREATE TABLE merge_trial (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    ts           TEXT NOT NULL,
    branches     TEXT NOT NULL,
    result       TEXT NOT NULL CHECK (result IN ('clean','conflict','test_fail','unverified')),
    detail       TEXT
  )`,
    `CREATE INDEX merge_trial_by_workspace ON merge_trial (workspace_id, ts)`,

    // event.kind CHECK constraint widening — SQLite can't ALTER a CHECK in
    // place, so this is a copy-drop-rename, identical in shape to migration
    // index 3's event_v4 rebuild (which added session.forked the same way).
    `CREATE TABLE event_v6 (
    id           TEXT PRIMARY KEY,
    session_id   TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    ts           TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('session.started', 'session.forked', 'commit.made', 'session.landed')),
    payload      TEXT NOT NULL
  )`,
    `INSERT INTO event_v6 (id, session_id, workspace_id, ts, kind, payload)
       SELECT id, session_id, workspace_id, ts, kind, payload FROM event`,
    `DROP TABLE event`,
    `ALTER TABLE event_v6 RENAME TO event`,
    `CREATE INDEX event_by_session ON event (session_id, ts)`,
    `CREATE INDEX event_by_workspace_kind ON event (workspace_id, kind, ts)`,
  ],
```

- [ ] **Step 2: Widen `IdPrefix` and `EventKind`**

```ts
// src/core/ids.ts
type IdPrefix = 'ws' | 's' | 'ev' | 'msg' | 'lease' | 'ctx' | 'fc' | 'ct' | 'mt';
```

The SQL `CHECK` constraint widened in Step 1 is only half of this — the
TypeScript `EventKind` union in `src/db/repositories/event.ts` must widen
too, or `EventLedger.append({ kind: 'session.landed', ... })` (Task 6) fails
to typecheck even though the database would accept the row fine:

```ts
// src/db/repositories/event.ts
export type EventKind = 'session.started' | 'session.forked' | 'commit.made' | 'session.landed';
```

- [ ] **Step 3: Write the failing repo test**

```ts
// tests/db/merge-trial-repo.test.ts
import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { MergeTrialRepo, type MergeTrialRow } from '../../src/db/repositories/merge-trial.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';

function row(overrides: Partial<MergeTrialRow> = {}): MergeTrialRow {
  return {
    id: 'mt_1', workspaceId: 'ws_1', ts: 'now',
    branches: ['cw/a', 'cw/b'], result: 'clean', detail: null,
    ...overrides,
  };
}

function seed(db: ReturnType<typeof openDatabase>) {
  new WorkspaceRepo(db).insert({
    id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
    defaultIsolation: 'worktree', safeModeTier: 'T1',
  });
}

describe('MergeTrialRepo', () => {
  test('insert then listByWorkspace round-trips, branches parsed back to an array', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const repo = new MergeTrialRepo(db);
    repo.insert(row());

    const rows = repo.listByWorkspace('ws_1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.branches).toEqual(['cw/a', 'cw/b']);
    expect(rows[0]?.result).toBe('clean');
    expect(rows[0]?.detail).toBeNull();
  });

  test('listByWorkspace orders oldest first, matching every other listByWorkspace in this codebase', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const repo = new MergeTrialRepo(db);
    repo.insert(row({ id: 'mt_1', ts: '2026-01-01T00:00:01.000Z' }));
    repo.insert(row({ id: 'mt_2', ts: '2026-01-01T00:00:02.000Z' }));

    const rows = repo.listByWorkspace('ws_1');
    expect(rows.map((r) => r.id)).toEqual(['mt_1', 'mt_2']);
  });

  test('a conflict result carries the conflicting file list in detail', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const repo = new MergeTrialRepo(db);
    repo.insert(row({ result: 'conflict', detail: 'src/x.ts\nsrc/y.ts' }));

    expect(repo.listByWorkspace('ws_1')[0]?.detail).toBe('src/x.ts\nsrc/y.ts');
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `bun test tests/db/merge-trial-repo.test.ts` — expect FAIL (module not found).

- [ ] **Step 5: Implement `MergeTrialRepo`**

```ts
// src/db/repositories/merge-trial.ts
import type { Database } from 'bun:sqlite';

export type MergeTrialResult = 'clean' | 'conflict' | 'test_fail' | 'unverified';

export interface MergeTrialRow {
  id: string;
  workspaceId: string;
  ts: string;
  branches: string[];
  result: MergeTrialResult;
  detail: string | null;
}

interface MergeTrialRecord {
  id: string;
  workspace_id: string;
  ts: string;
  branches: string;
  result: string;
  detail: string | null;
}

const COLS = 'id,workspace_id,ts,branches,result,detail';

function toRow(r: MergeTrialRecord): MergeTrialRow {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    ts: r.ts,
    branches: JSON.parse(r.branches) as string[],
    result: r.result as MergeTrialResult,
    detail: r.detail,
  };
}

export class MergeTrialRepo {
  constructor(private readonly db: Database) {}

  insert(row: MergeTrialRow): void {
    this.db
      .prepare(`INSERT INTO merge_trial (${COLS}) VALUES (?,?,?,?,?,?)`)
      .run(row.id, row.workspaceId, row.ts, JSON.stringify(row.branches), row.result, row.detail);
  }

  listByWorkspace(workspaceId: string): MergeTrialRow[] {
    return (
      this.db
        .prepare(`SELECT ${COLS} FROM merge_trial WHERE workspace_id=? ORDER BY ts ASC`)
        .all(workspaceId) as MergeTrialRecord[]
    ).map(toRow);
  }
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `bun test tests/db/merge-trial-repo.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 7: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: 0 errors, all previously-passing tests still pass (368 baseline
per the M3 merge — confirm your new total is 368+3).

- [ ] **Step 8: Commit**

```bash
git add src/db/schema.ts src/db/repositories/merge-trial.ts src/core/ids.ts src/db/repositories/event.ts tests/db/merge-trial-repo.test.ts
git commit -m "feat(db): add merge_trial schema and the session.landed event kind (migration 6)"
```

---

### Task 2: Integration worktree lifecycle

**Files:**
- Create: `src/convergence/integration-worktree.ts`
- Modify: `src/domain/session.ts`
- Test: `tests/convergence/integration-worktree.test.ts`

**Interfaces:**
- Consumes: `SessionRepo` (existing), `simple-git` (existing pattern from
  `src/isolation/worktree.ts`), `LeaseManager` (existing, Task 4/5 need
  `withIntegrationLease`).
- Produces: `ensureIntegrationWorktree(db, workspaceId, projectRoot):
  Promise<{ sessionId: string; path: string; branch: string }>`,
  `withIntegrationLease<T>(leaseManager, sessionId, fn: (env:
  Record<string,string>) => Promise<T>): Promise<T>` — Task 4's scheduler
  and Task 6's `cw land` handler both call `ensureIntegrationWorktree`
  before running any trial.

- [ ] **Step 1: Reserve the integration session name**

In `src/domain/session.ts`, alongside the existing `VALID_SESSION_NAME`/
`MAX_SESSION_NAME` constants:

```ts
/**
 * The Convergence Engine's scratch worktree (Task 2) is backed by a real
 * session row so `lease.session_id`'s foreign key has something to point
 * at. This name is reserved so a user can never accidentally (or
 * maliciously) claim it and shadow the engine's own row.
 */
const RESERVED_SESSION_NAME = '__integration__';
```

In `assertValidSessionName`, add the reservation check before the regex
check:

```ts
function assertValidSessionName(name: string): void {
  if (name === RESERVED_SESSION_NAME) {
    throw new CrossweaveError('INVALID_SESSION_NAME', `"${RESERVED_SESSION_NAME}" is reserved for internal use`);
  }
  if (name.length > MAX_SESSION_NAME || !VALID_SESSION_NAME.test(name)) {
    throw new CrossweaveError(
      'INVALID_SESSION_NAME',
      `Session name must be 1-${MAX_SESSION_NAME} characters of letters, digits, ` +
        `dash or underscore and start with a letter or digit, got ${JSON.stringify(name)}`,
    );
  }
}
```

Export `RESERVED_SESSION_NAME` (add `export` to its declaration) — Task 2's
new module needs the exact same string.

Also filter `SessionManager.list` so the integration session never appears
in `cw session list` or any other caller of this method — it is
infrastructure, not a session a user ever interacts with directly:

```ts
  list(workspaceId: string): SessionRow[] {
    return this.sessions.listByWorkspace(workspaceId).filter((s) => s.agentKind !== 'integration');
  }
```

- [ ] **Step 2: Write the failing integration-worktree test**

```ts
// tests/convergence/integration-worktree.test.ts
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { ensureIntegrationWorktree } from '../../src/convergence/integration-worktree.js';
import { makeGitFixture, type GitFixture } from '../helpers/git-fixture.js';

describe('ensureIntegrationWorktree', () => {
  test('creates the worktree at .crossweave/integration on branch cw/integration', async () => {
    const fixture = await makeGitFixture();
    try {
      const db = openDatabase(':memory:');
      new WorkspaceRepo(db).insert({
        id: 'ws_1', name: 'w', rootPath: fixture.root, createdAt: 'now',
        defaultIsolation: 'worktree', safeModeTier: 'T1',
      });

      const handle = await ensureIntegrationWorktree(db, 'ws_1', fixture.root);
      expect(handle.path).toBe(join(fixture.root, '.crossweave', 'integration'));
      expect(handle.branch).toBe('cw/integration');
      expect(existsSync(handle.path)).toBe(true);

      const row = new SessionRepo(db).findById(handle.sessionId);
      expect(row?.agentKind).toBe('integration');
      expect(row?.name).toBe('__integration__');
    } finally {
      await fixture.cleanup();
    }
  });

  test('a second call reuses the same worktree and session row', async () => {
    const fixture = await makeGitFixture();
    try {
      const db = openDatabase(':memory:');
      new WorkspaceRepo(db).insert({
        id: 'ws_1', name: 'w', rootPath: fixture.root, createdAt: 'now',
        defaultIsolation: 'worktree', safeModeTier: 'T1',
      });

      const first = await ensureIntegrationWorktree(db, 'ws_1', fixture.root);
      const second = await ensureIntegrationWorktree(db, 'ws_1', fixture.root);
      expect(second.sessionId).toBe(first.sessionId);
      expect(new SessionRepo(db).listByWorkspace('ws_1')).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });
});
```

- [ ] **Step 3: Run to verify failure, then implement**

Run: `bun test tests/convergence/integration-worktree.test.ts` — expect FAIL (module not found).

```ts
// src/convergence/integration-worktree.ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { simpleGit } from 'simple-git';
import { newId } from '../core/ids.js';
import { crossweaveDir } from '../core/paths.js';
import { SessionRepo, type SessionRow } from '../db/repositories/session.js';
import type { LeaseManager } from '../isolation/leases/manager.js';

export const INTEGRATION_SESSION_NAME = '__integration__';
export const INTEGRATION_BRANCH = 'cw/integration';

export interface IntegrationWorktree {
  sessionId: string;
  path: string;
  branch: string;
}

/**
 * Creates (or reuses) the Convergence Engine's scratch worktree and its
 * backing session row. Idempotent and safe to call on every trial — the
 * common case is a fast row lookup, not a fresh `git worktree add`.
 *
 * A stale row (worktree directory gone, e.g. after a crash mid-teardown) is
 * deleted and recreated from scratch rather than trusted — a torn-down
 * worktree's row pointing at a path that no longer exists would make every
 * lease acquisition succeed while every git command against it fails.
 */
export async function ensureIntegrationWorktree(
  db: Database,
  workspaceId: string,
  projectRoot: string,
): Promise<IntegrationWorktree> {
  const sessions = new SessionRepo(db);
  const existing = sessions.findByName(workspaceId, INTEGRATION_SESSION_NAME);
  if (existing?.worktreePath !== undefined && existing?.worktreePath !== null && existsSync(existing.worktreePath)) {
    return { sessionId: existing.id, path: existing.worktreePath, branch: existing.branch ?? INTEGRATION_BRANCH };
  }
  if (existing) sessions.delete(existing.id);

  const path = join(crossweaveDir(projectRoot), 'integration');
  const git = simpleGit(projectRoot);
  // Best-effort cleanup of a previous crash's half-torn-down state — a
  // stale worktree registration or branch left over from before must not
  // make the fresh `worktree add` below fail.
  await git.raw(['worktree', 'remove', '--force', path]).catch(() => undefined);
  await git.raw(['branch', '-D', INTEGRATION_BRANCH]).catch(() => undefined);

  const forkPoint = (await git.raw(['rev-parse', '--verify', 'HEAD'])).trim();
  await git.raw(['worktree', 'add', '-b', INTEGRATION_BRANCH, path, forkPoint]);

  const id = newId('s');
  const now = new Date().toISOString();
  const row: SessionRow = {
    id, workspaceId, name: INTEGRATION_SESSION_NAME, agentKind: 'integration', adapter: 'integration',
    status: 'idle', worktreePath: path, branch: INTEGRATION_BRANCH, createdAt: now, lastActiveAt: now,
    tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
  };
  sessions.insert(row);
  return { sessionId: id, path, branch: INTEGRATION_BRANCH };
}

/**
 * Runs `fn` with the integration worktree's resource lease held — exactly
 * a session's own lease lifecycle (acquired for the duration of real work,
 * released immediately after), not held permanently. Only needed around an
 * actual `converge.testCommand` run; a bare merge trial touches no
 * port/db/docker/cache and does not need this.
 */
export async function withIntegrationLease<T>(
  leaseManager: LeaseManager,
  sessionId: string,
  fn: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
  const env = await leaseManager.acquire(sessionId);
  try {
    return await fn(env);
  } finally {
    leaseManager.release(sessionId);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/convergence/integration-worktree.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Add tests for the reserved-name rejection and the list filter**

In `tests/domain/session.test.ts` (existing file — add alongside its other
`assertValidSessionName`-adjacent tests, using whatever `SessionManager`
setup fixture the file already has):

```ts
test('rejects the reserved integration session name', async () => {
  await expect(
    sessions.create({ workspaceId, name: '__integration__', agent: 'claude', worktree: false }),
  ).rejects.toMatchObject({ code: 'INVALID_SESSION_NAME' });
});

test('list() never returns an integration-kind session row', () => {
  // Inserted directly via the repo, the same way ensureIntegrationWorktree
  // does (Task 2) — bypassing create()'s validation entirely, since that's
  // exactly how the real integration row gets created.
  sessionRepo.insert({
    id: 's_integration', workspaceId, name: '__integration__', agentKind: 'integration', adapter: 'integration',
    status: 'idle', worktreePath: '/tmp/integration', branch: 'cw/integration', createdAt: 'now',
    lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
  });
  expect(sessions.list(workspaceId).map((s) => s.id)).not.toContain('s_integration');
});
```

The second test needs direct `SessionRepo` access alongside the file's
existing `SessionManager` instance — import `SessionRepo` from
`../../src/db/repositories/session.js` if the file doesn't already, and
construct `const sessionRepo = new SessionRepo(db);` against the same `db`
the `SessionManager` under test was built with.

- [ ] **Step 6: Run to verify it passes, then typecheck and full suite**

Run: `bun test tests/domain/session.test.ts tests/convergence/`
Expected: PASS (all, including the new reserved-name test)

Run: `bun run typecheck && bun test`
Expected: 0 errors, all green.

- [ ] **Step 7: Commit**

```bash
git add src/convergence/integration-worktree.ts src/domain/session.ts tests/convergence/integration-worktree.test.ts tests/domain/session.test.ts
git commit -m "feat(convergence): integration worktree lifecycle and reserved session name"
```

---

### Task 3: Merge-trial git mechanics

**Files:**
- Create: `src/convergence/trial.ts`
- Test: `tests/convergence/trial.test.ts`

**Interfaces:**
- Produces: `runMergeTrial(integrationPath, baseHead, branches: string[]):
  Promise<TrialResult>` (`TrialResult = { result: 'clean' | 'conflict';
  detail: string | null }` — `test_fail`/`unverified` are decided by the
  CALLER after a clean result, not by this function), `resetIntegration
  (integrationPath, baseHead): void`. Task 4 (scheduler) and Task 6
  (`cw land`) both call these directly against the worktree Task 2 hands
  back.

- [ ] **Step 1: Write the failing trial-mechanics tests**

```ts
// tests/convergence/trial.test.ts
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runMergeTrial, resetIntegration } from '../../src/convergence/trial.js';
import { makeGitFixture, commitFile, type GitFixture } from '../helpers/git-fixture.js';
import { $ } from 'bun';

async function branchFrom(root: string, name: string): Promise<void> {
  await $`git branch ${name}`.cwd(root).quiet();
}

async function checkoutNew(root: string, name: string): Promise<void> {
  await $`git checkout -q -b ${name}`.cwd(root).quiet();
}

describe('runMergeTrial', () => {
  test('two non-conflicting branches merge clean', async () => {
    const fixture = await makeGitFixture();
    try {
      const base = (await $`git rev-parse HEAD`.cwd(fixture.root).quiet().text()).trim();
      await checkoutNew(fixture.root, 'cw/a');
      await commitFile(fixture.root, 'a.txt', 'a\n', 'add a');
      await $`git checkout -q main`.cwd(fixture.root).quiet();
      await checkoutNew(fixture.root, 'cw/b');
      await commitFile(fixture.root, 'b.txt', 'b\n', 'add b');
      await $`git checkout -q main`.cwd(fixture.root).quiet();

      const result = await runMergeTrial(fixture.root, base, ['cw/a', 'cw/b']);
      expect(result.result).toBe('clean');
      expect(result.detail).toBeNull();
      expect(existsSync(join(fixture.root, 'a.txt'))).toBe(true);
      expect(existsSync(join(fixture.root, 'b.txt'))).toBe(true);

      resetIntegration(fixture.root, base);
      expect(existsSync(join(fixture.root, 'a.txt'))).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  test('two branches editing the same line conflict, and the conflicting file is named', async () => {
    const fixture = await makeGitFixture();
    try {
      await commitFile(fixture.root, 'shared.txt', 'base\n', 'seed shared file');
      const base = (await $`git rev-parse HEAD`.cwd(fixture.root).quiet().text()).trim();
      await checkoutNew(fixture.root, 'cw/a');
      await commitFile(fixture.root, 'shared.txt', 'from a\n', 'a edits shared');
      await $`git checkout -q main`.cwd(fixture.root).quiet();
      await checkoutNew(fixture.root, 'cw/b');
      await commitFile(fixture.root, 'shared.txt', 'from b\n', 'b edits shared');
      await $`git checkout -q main`.cwd(fixture.root).quiet();

      const result = await runMergeTrial(fixture.root, base, ['cw/a', 'cw/b']);
      expect(result.result).toBe('conflict');
      expect(result.detail).toContain('shared.txt');

      resetIntegration(fixture.root, base);
      expect(readFileSync(join(fixture.root, 'shared.txt'), 'utf8')).toBe('base\n');
    } finally {
      await fixture.cleanup();
    }
  });

  test('a trial is idempotent: running it twice in a row against the same base produces the same result', async () => {
    const fixture = await makeGitFixture();
    try {
      const base = (await $`git rev-parse HEAD`.cwd(fixture.root).quiet().text()).trim();
      await checkoutNew(fixture.root, 'cw/a');
      await commitFile(fixture.root, 'a.txt', 'a\n', 'add a');
      await $`git checkout -q main`.cwd(fixture.root).quiet();

      const first = await runMergeTrial(fixture.root, base, ['cw/a']);
      resetIntegration(fixture.root, base);
      const second = await runMergeTrial(fixture.root, base, ['cw/a']);
      resetIntegration(fixture.root, base);

      expect(first).toEqual(second);
    } finally {
      await fixture.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run to verify failure, then implement**

Run: `bun test tests/convergence/trial.test.ts` — expect FAIL (module not found).

```ts
// src/convergence/trial.ts
import { execFileSync } from 'node:child_process';

export interface TrialResult {
  result: 'clean' | 'conflict';
  detail: string | null;
}

/**
 * Checks out a fresh `cw/trial` branch at `baseHead` in `integrationPath`
 * and merges `branches` into it in order, `--no-commit --no-ff` (never
 * creating a real commit — this is a dry run). Stops at the first branch
 * that conflicts.
 *
 * Deliberately does NOT reset the worktree on either outcome — the caller
 * decides when to reset (Task 4's scheduler resets pairwise trials
 * immediately, but leaves a clean FULL-integration trial's merged state in
 * place long enough to run the test command against it). Call
 * `resetIntegration` explicitly once done with the result.
 */
export async function runMergeTrial(
  integrationPath: string,
  baseHead: string,
  branches: string[],
): Promise<TrialResult> {
  execFileSync('git', ['checkout', '-B', 'cw/trial', baseHead], {
    cwd: integrationPath, stdio: ['ignore', 'pipe', 'pipe'],
  });

  for (const branch of branches) {
    try {
      execFileSync('git', ['merge', '--no-commit', '--no-ff', branch], {
        cwd: integrationPath, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      const conflicted = execFileSync(
        'git', ['diff', '--name-only', '--diff-filter=U'],
        { cwd: integrationPath, encoding: 'utf8' },
      ).trim();
      try {
        execFileSync('git', ['merge', '--abort'], { cwd: integrationPath, stdio: 'ignore' });
      } catch {
        // Nothing to abort — an unexpected non-conflict failure already left no merge in progress.
      }
      return { result: 'conflict', detail: conflicted.length > 0 ? conflicted : null };
    }
  }

  return { result: 'clean', detail: null };
}

/** Returns the integration worktree to a clean state at `baseHead`, ready for the next trial. */
export function resetIntegration(integrationPath: string, baseHead: string): void {
  try {
    execFileSync('git', ['merge', '--abort'], { cwd: integrationPath, stdio: 'ignore' });
  } catch {
    // Nothing was in progress — the common case after a clean trial.
  }
  execFileSync('git', ['reset', '--hard', baseHead], { cwd: integrationPath, stdio: 'ignore' });
}
```

- [ ] **Step 3: Run to verify it passes**

Run: `bun test tests/convergence/trial.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 4: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: 0 errors, all green.

- [ ] **Step 5: Commit**

```bash
git add src/convergence/trial.ts tests/convergence/trial.test.ts
git commit -m "feat(convergence): merge-trial git mechanics (pairwise and full-integration)"
```

---

### Task 4: Trial-merge scheduler

**Files:**
- Create: `src/daemon/convergence-scheduler.ts`
- Modify: `src/core/config.ts`
- Modify: `src/daemon/methods.ts`
- Test: `tests/daemon/convergence-scheduler.test.ts`

**Interfaces:**
- Consumes: `ensureIntegrationWorktree`, `withIntegrationLease` (Task 2),
  `runMergeTrial`, `resetIntegration` (Task 3), `MergeTrialRepo` (Task 1).
- Produces: `class ConvergenceScheduler { start(): void; stop(): void }` —
  constructed once in `buildMethods`, started at daemon boot, stopped on
  `daemon.shutdown`.

- [ ] **Step 1: Add `converge` config**

```ts
// src/core/config.ts — extend CrossweaveConfig and DEFAULT_CONFIG
export interface CrossweaveConfig {
  ports: { base: number; blockSize: number; named: Record<string, number> };
  disk: { perSessionBytes: number; perWorkspaceBytes: number };
  db: { strategy: 'none' | 'schema' | 'file-copy'; url?: string };
  cacheIsolation: boolean;
  converge: {
    testCommand?: string;
    mergeStrategy: 'merge' | 'squash' | 'rebase';
    trialDebounceMs: number;
    fullIntegrationIntervalMs: number;
    pairwiseSessionThreshold: number;
  };
}

export const DEFAULT_CONFIG: CrossweaveConfig = {
  ports: { base: 43000, blockSize: 10, named: {} },
  disk: { perSessionBytes: 2 * 1024 * 1024 * 1024, perWorkspaceBytes: 20 * 1024 * 1024 * 1024 },
  db: { strategy: 'none' },
  cacheIsolation: true,
  converge: {
    mergeStrategy: 'squash',
    trialDebounceMs: 30_000,
    fullIntegrationIntervalMs: 300_000,
    pairwiseSessionThreshold: 8,
  },
};
```

In `loadConfig`, merge the `converge` section one level deep (matching the
existing `ports`/`disk` merge pattern) and validate:

```ts
  const config: CrossweaveConfig = {
    ports: { ...DEFAULT_CONFIG.ports, ...input.ports },
    disk: { ...DEFAULT_CONFIG.disk, ...input.disk },
    db: { ...DEFAULT_CONFIG.db, ...input.db },
    cacheIsolation: input.cacheIsolation ?? DEFAULT_CONFIG.cacheIsolation,
    converge: { ...DEFAULT_CONFIG.converge, ...input.converge },
  };
```

```ts
  const STRATEGIES_CONVERGE = new Set(['merge', 'squash', 'rebase']);
  if (config.converge.testCommand !== undefined && typeof config.converge.testCommand !== 'string') {
    invalid('converge.testCommand must be a string if set');
  }
  if (!STRATEGIES_CONVERGE.has(config.converge.mergeStrategy)) {
    invalid(`converge.mergeStrategy must be one of merge, squash, rebase, got ${String(config.converge.mergeStrategy)}`);
  }
  if (!Number.isInteger(config.converge.trialDebounceMs) || config.converge.trialDebounceMs < 0) {
    invalid('converge.trialDebounceMs must be a non-negative integer');
  }
  if (!Number.isInteger(config.converge.fullIntegrationIntervalMs) || config.converge.fullIntegrationIntervalMs < 0) {
    invalid('converge.fullIntegrationIntervalMs must be a non-negative integer');
  }
  if (!Number.isInteger(config.converge.pairwiseSessionThreshold) || config.converge.pairwiseSessionThreshold < 1) {
    invalid('converge.pairwiseSessionThreshold must be a positive integer');
  }
```

- [ ] **Step 2: Write the failing scheduler test**

The scheduler's tick logic is exercised directly (calling a testable
`tick()`-equivalent method manually), never through a real `setInterval` —
matching this project's established policy against timing-dependent tests.

```ts
// tests/daemon/convergence-scheduler.test.ts
import { describe, expect, test } from 'bun:test';
import { $ } from 'bun';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { LeaseManager } from '../../src/isolation/leases/manager.js';
import { MergeTrialRepo } from '../../src/db/repositories/merge-trial.js';
import { ConvergenceScheduler } from '../../src/daemon/convergence-scheduler.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { makeGitFixture, commitFile, type GitFixture } from '../helpers/git-fixture.js';

async function branchWithFile(root: string, branch: string, file: string, content: string): Promise<void> {
  await $`git checkout -q -b ${branch}`.cwd(root).quiet();
  await commitFile(root, file, content, `add ${file}`);
  await $`git checkout -q main`.cwd(root).quiet();
}

async function setup(fixture: GitFixture) {
  const db = openDatabase(':memory:');
  new WorkspaceRepo(db).insert({
    id: 'ws_1', name: 'w', rootPath: fixture.root, createdAt: 'now',
    defaultIsolation: 'worktree', safeModeTier: 'T1',
  });
  const sessions = new SessionRepo(db);
  const config = { ...DEFAULT_CONFIG, converge: { ...DEFAULT_CONFIG.converge, trialDebounceMs: 0 } };
  const leaseManager = new LeaseManager(db, fixture.root, config);
  const scheduler = new ConvergenceScheduler(db, fixture.root, config, leaseManager);
  return { db, sessions, leaseManager, scheduler };
}

describe('ConvergenceScheduler', () => {
  test('a pairwise trial between two clean-merging session branches records "clean"', async () => {
    const fixture = await makeGitFixture();
    try {
      await branchWithFile(fixture.root, 'cw/a', 'a.txt', 'a\n');
      await branchWithFile(fixture.root, 'cw/b', 'b.txt', 'b\n');
      const { db, sessions, scheduler } = await setup(fixture);
      sessions.insert({
        id: 's_a', workspaceId: 'ws_1', name: 'a', agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: fixture.root, branch: 'cw/a', createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
      });
      sessions.insert({
        id: 's_b', workspaceId: 'ws_1', name: 'b', agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: fixture.root, branch: 'cw/b', createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
      });

      await scheduler.tick();

      const trials = new MergeTrialRepo(db).listByWorkspace('ws_1');
      const pairwise = trials.filter((t) => t.branches.length === 2);
      expect(pairwise).toHaveLength(1);
      expect(pairwise[0]?.result).toBe('clean');
    } finally {
      await fixture.cleanup();
    }
  });

  test('a pairwise trial between conflicting branches records "conflict" with the conflicting file named', async () => {
    const fixture = await makeGitFixture();
    try {
      await commitFile(fixture.root, 'shared.txt', 'base\n', 'seed');
      await branchWithFile(fixture.root, 'cw/a', 'shared.txt', 'from a\n');
      await branchWithFile(fixture.root, 'cw/b', 'shared.txt', 'from b\n');
      const { db, sessions, scheduler } = await setup(fixture);
      sessions.insert({
        id: 's_a', workspaceId: 'ws_1', name: 'a', agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: fixture.root, branch: 'cw/a', createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
      });
      sessions.insert({
        id: 's_b', workspaceId: 'ws_1', name: 'b', agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: fixture.root, branch: 'cw/b', createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
      });

      await scheduler.tick();

      const pairwise = new MergeTrialRepo(db).listByWorkspace('ws_1').filter((t) => t.branches.length === 2);
      expect(pairwise).toHaveLength(1);
      expect(pairwise[0]?.result).toBe('conflict');
      expect(pairwise[0]?.detail).toContain('shared.txt');
    } finally {
      await fixture.cleanup();
    }
  });

  test('a branch whose head has not changed since its last trial is not re-trialled', async () => {
    const fixture = await makeGitFixture();
    try {
      await branchWithFile(fixture.root, 'cw/a', 'a.txt', 'a\n');
      await branchWithFile(fixture.root, 'cw/b', 'b.txt', 'b\n');
      const { db, sessions, scheduler } = await setup(fixture);
      sessions.insert({
        id: 's_a', workspaceId: 'ws_1', name: 'a', agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: fixture.root, branch: 'cw/a', createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
      });
      sessions.insert({
        id: 's_b', workspaceId: 'ws_1', name: 'b', agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: fixture.root, branch: 'cw/b', createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
      });

      await scheduler.tick();
      await scheduler.tick();

      const pairwise = new MergeTrialRepo(db).listByWorkspace('ws_1').filter((t) => t.branches.length === 2);
      expect(pairwise).toHaveLength(1); // not 2 — the second tick found nothing due
    } finally {
      await fixture.cleanup();
    }
  });

  test('the integration session never appears as a trial participant', async () => {
    const fixture = await makeGitFixture();
    try {
      await branchWithFile(fixture.root, 'cw/a', 'a.txt', 'a\n');
      const { sessions, scheduler } = await setup(fixture);
      sessions.insert({
        id: 's_a', workspaceId: 'ws_1', name: 'a', agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: fixture.root, branch: 'cw/a', createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
      });

      // A single active session has no PARTNER to pair against — this must
      // not crash, and must leave zero pairwise trials.
      await expect(scheduler.tick()).resolves.toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  });
});
```

- [ ] **Step 3: Run to verify failure, then implement**

Run: `bun test tests/daemon/convergence-scheduler.test.ts` — expect FAIL (module not found).

```ts
// src/daemon/convergence-scheduler.ts
import { execFileSync } from 'node:child_process';
import type { Database } from 'bun:sqlite';
import { newId } from '../core/ids.js';
import type { CrossweaveConfig } from '../core/config.js';
import type { LeaseManager } from '../isolation/leases/manager.js';
import { WorkspaceRepo } from '../db/repositories/workspace.js';
import { SessionRepo, type SessionRow } from '../db/repositories/session.js';
import { MergeTrialRepo } from '../db/repositories/merge-trial.js';
import { ensureIntegrationWorktree, withIntegrationLease } from '../convergence/integration-worktree.js';
import { runMergeTrial, resetIntegration } from '../convergence/trial.js';

const TICK_MS = 5_000;

function currentHead(projectRoot: string, branch: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--verify', branch], {
      cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined; // branch gone (session removed mid-tick) — skip it this round
  }
}

function baseHead(projectRoot: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Time-boxed, not event-driven — a trial only cares about COMMITTED state
 * (you cannot `git merge` uncommitted work), so this ticks on an interval
 * and reads branch HEADs directly, unlike Radar's `fs.watch`-driven
 * reaction to working-tree writes.
 *
 * One job runs at a time: the scratch worktree can only run one `git
 * merge` at a time, so `tick()` processes its whole queue of due pairs
 * sequentially before returning, and the next scheduled tick is a no-op if
 * the previous one is still running (guarded by `running`).
 */
export class ConvergenceScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private readonly lastTrialHead = new Map<string, string>(); // branch -> head sha
  private readonly lastTrialAt = new Map<string, number>(); // branch -> ts ms
  private readonly triedPairs = new Set<string>(); // `${branchA}@${headA}|${branchB}@${headB}`, sorted
  private lastFullIntegrationAt = 0;

  private readonly workspaces: WorkspaceRepo;
  private readonly sessions: SessionRepo;
  private readonly mergeTrials: MergeTrialRepo;

  constructor(
    private readonly db: Database,
    private readonly projectRoot: string,
    private readonly config: CrossweaveConfig,
    private readonly leaseManager: LeaseManager,
  ) {
    this.workspaces = new WorkspaceRepo(db);
    this.sessions = new SessionRepo(db);
    this.mergeTrials = new MergeTrialRepo(db);
  }

  start(): void {
    this.timer = setInterval(() => {
      void this.tick().catch((err: unknown) => {
        process.stderr.write(`crossweave: convergence tick failed: ${String(err)}\n`);
      });
    }, TICK_MS);
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  private activeBranchSessions(workspaceId: string): SessionRow[] {
    return this.sessions
      .listByWorkspace(workspaceId)
      .filter(
        (s) =>
          s.agentKind !== 'integration' &&
          (s.status === 'running' || s.status === 'idle') &&
          s.worktreePath !== null &&
          s.branch !== null,
      );
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const workspace of this.workspaces.list()) {
        await this.tickWorkspace(workspace.id, workspace.rootPath);
      }
    } finally {
      this.running = false;
    }
  }

  private async tickWorkspace(workspaceId: string, projectRoot: string): Promise<void> {
    const active = this.activeBranchSessions(workspaceId);
    if (active.length < 2) return; // nothing to pair against

    const now = Date.now();
    const due = active.filter((s) => {
      const branch = s.branch as string;
      const head = currentHead(projectRoot, branch);
      if (head === undefined) return false;
      const changed = this.lastTrialHead.get(branch) !== head;
      const cooledDown = now - (this.lastTrialAt.get(branch) ?? 0) >= this.config.converge.trialDebounceMs;
      return changed && cooledDown;
    });
    if (due.length === 0) return;

    if (active.length > this.config.converge.pairwiseSessionThreshold) {
      // Degrade: full-integration only, no pairwise trials at all this round.
      // §5 of the design doc — cw converge status (Task 5) reports this explicitly.
      return;
    }

    const base = baseHead(projectRoot);
    if (base === undefined) return;

    const integration = await ensureIntegrationWorktree(this.db, workspaceId, projectRoot);

    for (const session of due) {
      const branchA = session.branch as string;
      const headA = currentHead(projectRoot, branchA);
      if (headA === undefined) continue;

      for (const partner of active) {
        if (partner.id === session.id) continue;
        const branchB = partner.branch as string;
        const headB = currentHead(projectRoot, branchB);
        if (headB === undefined) continue;

        const pairKey = [`${branchA}@${headA}`, `${branchB}@${headB}`].sort().join('|');
        if (this.triedPairs.has(pairKey)) continue;

        const result = await runMergeTrial(integration.path, base, [branchA, branchB]);
        resetIntegration(integration.path, base);
        this.mergeTrials.insert({
          id: newId('mt'), workspaceId, ts: new Date().toISOString(),
          branches: [branchA, branchB], result: result.result, detail: result.detail,
        });
        this.triedPairs.add(pairKey);
      }

      this.lastTrialHead.set(branchA, headA);
      this.lastTrialAt.set(branchA, now);
    }

    await this.maybeRunFullIntegration(workspaceId, integration.sessionId, integration.path, base, active);
  }

  private async maybeRunFullIntegration(
    workspaceId: string,
    integrationSessionId: string,
    integrationPath: string,
    base: string,
    active: SessionRow[],
  ): Promise<void> {
    const now = Date.now();
    if (now - this.lastFullIntegrationAt < this.config.converge.fullIntegrationIntervalMs) return;

    // "a conflicting merge never reaches the test phase" — only proceed if
    // the most recent pairwise trial for every active pair is clean.
    const trials = this.mergeTrials.listByWorkspace(workspaceId).filter((t) => t.branches.length === 2);
    const latestByPair = new Map<string, (typeof trials)[number]>();
    for (const t of trials) latestByPair.set([...t.branches].sort().join('|'), t);
    const branches = active.map((s) => s.branch as string);
    for (let i = 0; i < branches.length; i += 1) {
      for (let j = i + 1; j < branches.length; j += 1) {
        const latest = latestByPair.get([branches[i], branches[j]].sort().join('|'));
        if (latest === undefined || latest.result !== 'clean') return; // unknown or conflicting pair — skip this round
      }
    }

    this.lastFullIntegrationAt = now;
    const result = await runMergeTrial(integrationPath, base, branches);
    if (result.result === 'conflict') {
      resetIntegration(integrationPath, base);
      this.mergeTrials.insert({
        id: newId('mt'), workspaceId, ts: new Date().toISOString(),
        branches, result: 'conflict', detail: result.detail,
      });
      return;
    }

    if (this.config.converge.testCommand === undefined) {
      resetIntegration(integrationPath, base);
      this.mergeTrials.insert({
        id: newId('mt'), workspaceId, ts: new Date().toISOString(),
        branches, result: 'unverified', detail: null,
      });
      return;
    }

    const testResult = await withIntegrationLease(this.leaseManager, integrationSessionId, async (env) => {
      this.sessions.updateStatus(integrationSessionId, 'running', null);
      try {
        const proc = Bun.spawn(['sh', '-c', this.config.converge.testCommand as string], {
          cwd: integrationPath, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe',
        });
        const [code, out, err] = await Promise.all([
          proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
        ]);
        return { code, tail: (out + err).slice(-4000) };
      } finally {
        this.sessions.updateStatus(integrationSessionId, 'idle', null);
      }
    });

    resetIntegration(integrationPath, base);
    this.mergeTrials.insert({
      id: newId('mt'), workspaceId, ts: new Date().toISOString(),
      branches,
      result: testResult.code === 0 ? 'clean' : 'test_fail',
      detail: testResult.code === 0 ? null : testResult.tail,
    });
  }
}
```

- [ ] **Step 4: Wire into `buildMethods`**

In `src/daemon/methods.ts`:

```ts
import { ConvergenceScheduler } from './convergence-scheduler.js';
// ... alongside the other top-of-buildMethods constructions ...
const convergenceScheduler = new ConvergenceScheduler(db, projectRoot, config, leaseManager);
convergenceScheduler.start();
```

In `'daemon.shutdown'`, stop it before the process exits:

```ts
    'daemon.shutdown': async () => {
      convergenceScheduler.stop();
      radarWatchers.stopAll();
      await runtime.stopAll();
      // ... unchanged from here ...
```

- [ ] **Step 5: Run to verify it passes**

Run: `bun test tests/daemon/convergence-scheduler.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: 0 errors, all green.

- [ ] **Step 7: Commit**

```bash
git add src/daemon/convergence-scheduler.ts src/core/config.ts src/daemon/methods.ts tests/daemon/convergence-scheduler.test.ts
git commit -m "feat(convergence): pairwise trial-merge scheduler with full-integration test runs"
```

---

### Task 5: Conflict graph, merge order, `converge.status` RPC, `cw converge status` CLI

**Files:**
- Create: `src/convergence/graph.ts`
- Modify: `src/daemon/methods.ts`
- Create: `src/cli/commands/converge.ts`
- Modify: `src/cli/index.ts`
- Test: `tests/convergence/graph.test.ts`
- Test: `tests/daemon/methods-converge.test.ts`

**Interfaces:**
- Consumes: `MergeTrialRepo` (Task 1).
- Produces: `buildConflictGraph(trials: MergeTrialRow[]): Map<string,
  Set<string>>` (branch -> set of branches it conflicts with, from latest
  pairwise result per pair), `recommendOrder(sessions: SessionRow[], graph):
  SessionRow[]`, the `converge.status` RPC, `cw converge status` CLI.

- [ ] **Step 1: Write the failing graph tests**

```ts
// tests/convergence/graph.test.ts
import { describe, expect, test } from 'bun:test';
import { buildConflictGraph, recommendOrder } from '../../src/convergence/graph.js';
import type { MergeTrialRow } from '../../src/db/repositories/merge-trial.js';
import type { SessionRow } from '../../src/db/repositories/session.js';

function trial(overrides: Partial<MergeTrialRow>): MergeTrialRow {
  return { id: 't', workspaceId: 'ws_1', ts: 'now', branches: [], result: 'clean', detail: null, ...overrides };
}

function session(id: string, branch: string, createdAt: string): SessionRow {
  return {
    id, workspaceId: 'ws_1', name: id, agentKind: 'claude', adapter: 'claude', status: 'running',
    worktreePath: `/tmp/${id}`, branch, createdAt, lastActiveAt: createdAt,
    tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
  };
}

describe('buildConflictGraph', () => {
  test('a conflicting pair produces a bidirectional edge', () => {
    const graph = buildConflictGraph([trial({ branches: ['cw/a', 'cw/b'], result: 'conflict' })]);
    expect(graph.get('cw/a')?.has('cw/b')).toBe(true);
    expect(graph.get('cw/b')?.has('cw/a')).toBe(true);
  });

  test('a clean pair produces no edge', () => {
    const graph = buildConflictGraph([trial({ branches: ['cw/a', 'cw/b'], result: 'clean' })]);
    expect(graph.get('cw/a')?.has('cw/b')).toBeFalsy();
  });

  test('only the LATEST trial for a pair counts — a later clean result clears an earlier conflict', () => {
    const graph = buildConflictGraph([
      trial({ ts: '2026-01-01T00:00:01.000Z', branches: ['cw/a', 'cw/b'], result: 'conflict' }),
      trial({ ts: '2026-01-01T00:00:02.000Z', branches: ['cw/a', 'cw/b'], result: 'clean' }),
    ]);
    expect(graph.get('cw/a')?.has('cw/b')).toBeFalsy();
  });

  test('full-integration trials (3+ branches) are ignored — the graph is pairwise only', () => {
    const graph = buildConflictGraph([trial({ branches: ['cw/a', 'cw/b', 'cw/c'], result: 'conflict' })]);
    expect(graph.size).toBe(0);
  });
});

describe('recommendOrder', () => {
  test('sorts by fewest conflicting partners first', () => {
    const sessions = [session('s_a', 'cw/a', '2026-01-01T00:00:01.000Z'), session('s_b', 'cw/b', '2026-01-01T00:00:02.000Z'), session('s_c', 'cw/c', '2026-01-01T00:00:03.000Z')];
    // a conflicts with both b and c; b and c don't conflict with each other
    const graph = buildConflictGraph([
      trial({ branches: ['cw/a', 'cw/b'], result: 'conflict' }),
      trial({ branches: ['cw/a', 'cw/c'], result: 'conflict' }),
      trial({ branches: ['cw/b', 'cw/c'], result: 'clean' }),
    ]);
    const order = recommendOrder(sessions, graph);
    expect(order[0]?.id).not.toBe('s_a'); // degree 2, must not be first
    expect(order.map((s) => s.id)).toContain('s_a');
  });

  test('ties break by createdAt ascending', () => {
    const sessions = [session('s_b', 'cw/b', '2026-01-01T00:00:02.000Z'), session('s_a', 'cw/a', '2026-01-01T00:00:01.000Z')];
    const graph = buildConflictGraph([]); // no conflicts at all — pure tiebreak
    const order = recommendOrder(sessions, graph);
    expect(order.map((s) => s.id)).toEqual(['s_a', 's_b']);
  });
});
```

- [ ] **Step 2: Run to verify failure, then implement**

Run: `bun test tests/convergence/graph.test.ts` — expect FAIL (module not found).

```ts
// src/convergence/graph.ts
import type { MergeTrialRow } from '../db/repositories/merge-trial.js';
import type { SessionRow } from '../db/repositories/session.js';

/** branch -> set of branches its LATEST pairwise trial says it conflicts with. */
export function buildConflictGraph(trials: MergeTrialRow[]): Map<string, Set<string>> {
  const latestByPair = new Map<string, MergeTrialRow>();
  for (const trial of trials) {
    if (trial.branches.length !== 2) continue; // pairwise only — full-integration rows don't feed the graph
    const key = [...trial.branches].sort().join('|');
    const existing = latestByPair.get(key);
    if (existing === undefined || trial.ts > existing.ts) latestByPair.set(key, trial);
  }

  const graph = new Map<string, Set<string>>();
  const edge = (a: string, b: string): void => {
    if (!graph.has(a)) graph.set(a, new Set());
    graph.get(a)?.add(b);
  };
  for (const trial of latestByPair.values()) {
    if (trial.result !== 'conflict') continue;
    const [a, b] = trial.branches as [string, string];
    edge(a, b);
    edge(b, a);
  }
  return graph;
}

/**
 * Greedy: merge the branches with the fewest conflicting partners first.
 * Ties break by session creation order (oldest first), matching every
 * other ordering convention in this codebase.
 */
export function recommendOrder(sessions: SessionRow[], graph: Map<string, Set<string>>): SessionRow[] {
  return [...sessions].sort((a, b) => {
    const degreeA = graph.get(a.branch ?? '')?.size ?? 0;
    const degreeB = graph.get(b.branch ?? '')?.size ?? 0;
    if (degreeA !== degreeB) return degreeA - degreeB;
    return a.createdAt.localeCompare(b.createdAt);
  });
}
```

- [ ] **Step 3: Run to verify it passes**

Run: `bun test tests/convergence/graph.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 4: Wire the `converge.status` RPC**

In `src/daemon/methods.ts`:

```ts
import { buildConflictGraph, recommendOrder } from '../convergence/graph.js';
```

```ts
    'converge.status': (p) => {
      const workspaceId = str(p, 'workspaceId');
      const trials = new MergeTrialRepo(db).listByWorkspace(workspaceId);
      const active = sessions
        .list(workspaceId)
        .filter((s) => s.agentKind !== 'integration' && (s.status === 'running' || s.status === 'idle') && s.branch !== null);

      const graph = buildConflictGraph(trials);
      const order = recommendOrder(active, graph);
      const pairwise: { a: string; b: string; result: string }[] = [];
      const seen = new Set<string>();
      for (const trial of [...trials].reverse()) {
        if (trial.branches.length !== 2) continue;
        const key = [...trial.branches].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        pairwise.push({ a: trial.branches[0] as string, b: trial.branches[1] as string, result: trial.result });
      }
      const fullIntegration = [...trials].reverse().find((t) => t.branches.length > 2) ?? null;
      const degraded = active.length > config.converge.pairwiseSessionThreshold;

      return {
        pairwise,
        fullIntegration: fullIntegration
          ? { result: fullIntegration.result, ts: fullIntegration.ts, detail: fullIntegration.detail }
          : null,
        recommendedOrder: order.map((s) => s.name),
        degraded,
      };
    },
```

Import `MergeTrialRepo` alongside the other repo imports at the top of the
file if not already present from Task 4.

- [ ] **Step 5: Write the failing `converge.status` RPC test**

```ts
// tests/daemon/methods-converge.test.ts
import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { MergeTrialRepo } from '../../src/db/repositories/merge-trial.js';

describe('converge.status RPC', () => {
  test('reports the pairwise matrix and recommended order from seeded trial data', async () => {
    const db = openDatabase(':memory:');
    new WorkspaceRepo(db).insert({
      id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
      defaultIsolation: 'worktree', safeModeTier: 'T1',
    });
    const sessions = new SessionRepo(db);
    sessions.insert({
      id: 's_a', workspaceId: 'ws_1', name: 'a', agentKind: 'claude', adapter: 'claude',
      status: 'running', worktreePath: '/tmp/a', branch: 'cw/a', createdAt: 'now',
      lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
    });
    sessions.insert({
      id: 's_b', workspaceId: 'ws_1', name: 'b', agentKind: 'claude', adapter: 'claude',
      status: 'running', worktreePath: '/tmp/b', branch: 'cw/b', createdAt: 'now',
      lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
    });
    new MergeTrialRepo(db).insert({
      id: 'mt_1', workspaceId: 'ws_1', ts: 'now', branches: ['cw/a', 'cw/b'], result: 'conflict', detail: 'x.ts',
    });

    const methods = buildMethods(db, '/tmp/w');
    const result = (await methods['converge.status']!(
      { workspaceId: 'ws_1' },
      { notify: () => undefined, onClose: () => undefined },
    )) as { pairwise: unknown[]; recommendedOrder: string[]; degraded: boolean };

    expect(result.pairwise).toHaveLength(1);
    expect(result.recommendedOrder).toEqual(['a', 'b']);
    expect(result.degraded).toBe(false);
  });

  test('reports degraded once active sessions exceed converge.pairwiseSessionThreshold', async () => {
    const db = openDatabase(':memory:');
    new WorkspaceRepo(db).insert({
      id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
      defaultIsolation: 'worktree', safeModeTier: 'T1',
    });
    const sessions = new SessionRepo(db);
    // DEFAULT_CONFIG.converge.pairwiseSessionThreshold is 8 — 9 active sessions crosses it.
    for (let i = 0; i < 9; i += 1) {
      sessions.insert({
        id: `s_${i}`, workspaceId: 'ws_1', name: `s${i}`, agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: `/tmp/${i}`, branch: `cw/s${i}`, createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
      });
    }

    const methods = buildMethods(db, '/tmp/w');
    const result = (await methods['converge.status']!(
      { workspaceId: 'ws_1' },
      { notify: () => undefined, onClose: () => undefined },
    )) as { degraded: boolean };

    expect(result.degraded).toBe(true);
  });
});
```

- [ ] **Step 6: Run to verify it passes**

Run: `bun test tests/daemon/methods-converge.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 7: `cw converge status` CLI**

```ts
// src/cli/commands/converge.ts
import { defineCommand } from 'citty';
import { withClient, fail, currentWorkspaceId } from '../context.js';

interface ConvergeStatus {
  pairwise: { a: string; b: string; result: string }[];
  fullIntegration: { result: string; ts: string; detail: string | null } | null;
  recommendedOrder: string[];
  degraded: boolean;
}

const statusCommand = defineCommand({
  meta: { name: 'status', description: 'Show the pairwise conflict matrix and recommended merge order' },
  async run() {
    try {
      await withClient(async (client) => {
        const workspaceId = await currentWorkspaceId(client);
        const status = await client.call<ConvergeStatus>('converge.status', { workspaceId });

        if (status.degraded) {
          process.stdout.write('note: pairwise trials disabled above the session threshold — showing full-integration only\n');
        }
        if (status.pairwise.length === 0) {
          process.stdout.write('no pairwise trials yet\n');
        } else {
          process.stdout.write('PAIR\tRESULT\n');
          for (const p of status.pairwise) process.stdout.write(`${p.a} <-> ${p.b}\t${p.result}\n`);
        }
        process.stdout.write(
          status.fullIntegration
            ? `full integration: ${status.fullIntegration.result} (${status.fullIntegration.ts})\n`
            : 'full integration: not yet run\n',
        );
        process.stdout.write(
          status.recommendedOrder.length > 0
            ? `recommended land order: ${status.recommendedOrder.join(' -> ')}\n`
            : 'recommended land order: (no active sessions)\n',
        );
      });
    } catch (err) { fail(err); }
  },
});

export const convergeCommand = defineCommand({
  meta: { name: 'converge', description: 'Trial-merge status and conflict graph' },
  subCommands: { status: statusCommand },
});
```

- [ ] **Step 8: Register the subcommand**

In `src/cli/index.ts`:

```ts
import { convergeCommand } from './commands/converge.js';
// ...
    converge: convergeCommand,
```

- [ ] **Step 9: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: 0 errors, all green.

- [ ] **Step 10: Commit**

```bash
git add src/convergence/graph.ts src/daemon/methods.ts src/cli/commands/converge.ts src/cli/index.ts tests/convergence/graph.test.ts tests/daemon/methods-converge.test.ts
git commit -m "feat(convergence): conflict graph, merge-order recommendation, cw converge status"
```

---

### Task 6: `cw land` RPC mechanics

**Files:**
- Create: `src/convergence/land.ts`
- Modify: `src/daemon/methods.ts`
- Test: `tests/convergence/land.test.ts`

**Interfaces:**
- Consumes: `ensureIntegrationWorktree`, `withIntegrationLease` (Task 2),
  `runMergeTrial`, `resetIntegration` (Task 3).
- Produces: `async function landSession(deps, workspaceId, sessionId, opts:
  { force: boolean }): Promise<LandResult>` — the `land.session` RPC method
  is a thin wrapper around this; Task 7's `cw land --all` CLI drives it
  session-by-session via the RPC, not by calling this function directly.

- [ ] **Step 1: Write the failing land-mechanics tests**

```ts
// tests/convergence/land.test.ts
import { describe, expect, test } from 'bun:test';
import { $ } from 'bun';
import { execFileSync } from 'node:child_process';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { EventRepo } from '../../src/db/repositories/event.js';
import { LeaseManager } from '../../src/isolation/leases/manager.js';
import { EventLedger } from '../../src/domain/ledger.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { landSession } from '../../src/convergence/land.js';
import { makeGitFixture, commitFile, type GitFixture } from '../helpers/git-fixture.js';

async function setup(fixture: GitFixture, config = DEFAULT_CONFIG) {
  const db = openDatabase(':memory:');
  new WorkspaceRepo(db).insert({
    id: 'ws_1', name: 'w', rootPath: fixture.root, createdAt: 'now',
    defaultIsolation: 'worktree', safeModeTier: 'T1',
  });
  const sessions = new SessionRepo(db);
  const leaseManager = new LeaseManager(db, fixture.root, config);
  const ledger = new EventLedger(db, fixture.root);
  return { db, sessions, leaseManager, ledger, config };
}

describe('landSession', () => {
  test('refuses a running session unless force', async () => {
    const fixture = await makeGitFixture();
    try {
      await $`git checkout -q -b cw/a`.cwd(fixture.root).quiet();
      await commitFile(fixture.root, 'a.txt', 'a\n', 'add a');
      await $`git checkout -q main`.cwd(fixture.root).quiet();
      const { db, sessions, leaseManager, ledger, config } = await setup(fixture);
      sessions.insert({
        id: 's_a', workspaceId: 'ws_1', name: 'a', agentKind: 'claude', adapter: 'claude',
        status: 'running', worktreePath: fixture.root, branch: 'cw/a', createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
      });

      await expect(
        landSession({ db, projectRoot: fixture.root, sessions, leaseManager, ledger, config }, 'ws_1', 's_a', { force: false }),
      ).rejects.toMatchObject({ code: 'SESSION_STILL_LIVE' });
    } finally {
      await fixture.cleanup();
    }
  });

  test('refuses on a fresh conflict against current base, naming the conflicting file', async () => {
    const fixture = await makeGitFixture();
    try {
      await commitFile(fixture.root, 'shared.txt', 'base\n', 'seed');
      await $`git checkout -q -b cw/a`.cwd(fixture.root).quiet();
      await commitFile(fixture.root, 'shared.txt', 'from a\n', 'a edits shared');
      await $`git checkout -q main`.cwd(fixture.root).quiet();
      await commitFile(fixture.root, 'shared.txt', 'from main\n', 'main edits shared too');

      const { db, sessions, leaseManager, ledger, config } = await setup(fixture);
      sessions.insert({
        id: 's_a', workspaceId: 'ws_1', name: 'a', agentKind: 'claude', adapter: 'claude',
        status: 'idle', worktreePath: fixture.root, branch: 'cw/a', createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
      });

      await expect(
        landSession({ db, projectRoot: fixture.root, sessions, leaseManager, ledger, config }, 'ws_1', 's_a', { force: false }),
      ).rejects.toMatchObject({ code: 'LAND_CONFLICT' });
    } finally {
      await fixture.cleanup();
    }
  });

  test('lands a clean session with no test command: squash-merges to base, marks landed, writes session.landed', async () => {
    const fixture = await makeGitFixture();
    try {
      await $`git checkout -q -b cw/a`.cwd(fixture.root).quiet();
      await commitFile(fixture.root, 'a.txt', 'a\n', 'add a');
      await $`git checkout -q main`.cwd(fixture.root).quiet();

      const { db, sessions, leaseManager, ledger, config } = await setup(fixture);
      sessions.insert({
        id: 's_a', workspaceId: 'ws_1', name: 'a', agentKind: 'claude', adapter: 'claude',
        status: 'idle', worktreePath: fixture.root, branch: 'cw/a', createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
      });

      const result = await landSession(
        { db, projectRoot: fixture.root, sessions, leaseManager, ledger, config }, 'ws_1', 's_a', { force: false },
      );
      expect(result.status).toBe('landed');

      const mainLog = execFileSync('git', ['log', '--oneline', '-1', 'main'], { cwd: fixture.root, encoding: 'utf8' });
      expect(mainLog).toBeTruthy();
      const mainFiles = execFileSync('git', ['ls-tree', '-r', '--name-only', 'main'], { cwd: fixture.root, encoding: 'utf8' });
      expect(mainFiles).toContain('a.txt');
      expect(sessions.findById('s_a')?.status).toBe('landed');

      const events = new EventRepo(db).listBySession('s_a');
      expect(events.some((e) => e.kind === 'session.landed')).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  test('reports unverified, not success, when no test command is configured', async () => {
    const fixture = await makeGitFixture();
    try {
      await $`git checkout -q -b cw/a`.cwd(fixture.root).quiet();
      await commitFile(fixture.root, 'a.txt', 'a\n', 'add a');
      await $`git checkout -q main`.cwd(fixture.root).quiet();

      const { db, sessions, leaseManager, ledger, config } = await setup(fixture);
      sessions.insert({
        id: 's_a', workspaceId: 'ws_1', name: 'a', agentKind: 'claude', adapter: 'claude',
        status: 'idle', worktreePath: fixture.root, branch: 'cw/a', createdAt: 'now',
        lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, enforcementTier: 'T3', pid: null,
      });

      const result = await landSession(
        { db, projectRoot: fixture.root, sessions, leaseManager, ledger, config }, 'ws_1', 's_a', { force: false },
      );
      expect(result.tested).toBe('unverified');
    } finally {
      await fixture.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run to verify failure, then implement**

Run: `bun test tests/convergence/land.test.ts` — expect FAIL (module not found).

```ts
// src/convergence/land.ts
import { execFileSync } from 'node:child_process';
import type { Database } from 'bun:sqlite';
import { CrossweaveError } from '../core/errors.js';
import type { CrossweaveConfig } from '../core/config.js';
import type { SessionRepo } from '../db/repositories/session.js';
import type { LeaseManager } from '../isolation/leases/manager.js';
import type { EventLedger } from '../domain/ledger.js';
import { removeWorktree, deleteBranch } from '../isolation/worktree.js';
import { ensureIntegrationWorktree, withIntegrationLease } from './integration-worktree.js';
import { runMergeTrial, resetIntegration } from './trial.js';

export interface LandDeps {
  db: Database;
  projectRoot: string;
  sessions: SessionRepo;
  leaseManager: LeaseManager;
  ledger: EventLedger;
  config: CrossweaveConfig;
}

export interface LandResult {
  status: 'landed';
  tested: 'clean' | 'unverified';
}

function currentBaseHead(projectRoot: string): string {
  return execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim();
}

function currentBaseBranch(projectRoot: string): string {
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim();
  if (branch === 'HEAD') {
    throw new CrossweaveError('LAND_NO_BASE_BRANCH', 'Cannot land: the project root is on a detached HEAD.');
  }
  return branch;
}

/**
 * The terminal operation of the whole product: gets a session's branch
 * into the base branch, for real, in the MAIN checkout (never the scratch
 * worktree, which only ever holds a throwaway trial). See the M4 design
 * doc §9 for the 5-step contract this implements.
 */
export async function landSession(
  deps: LandDeps,
  workspaceId: string,
  sessionId: string,
  opts: { force: boolean },
): Promise<LandResult> {
  const row = deps.sessions.findById(sessionId);
  if (!row || row.workspaceId !== workspaceId || row.agentKind === 'integration') {
    // The integration row resolves by id like any other session row, but it
    // is infrastructure, not a landable unit of work — treated as not
    // found rather than given its own error code, matching how it is
    // invisible everywhere else (SessionManager.list, cw session list).
    throw new CrossweaveError('SESSION_NOT_FOUND', `No such session: ${sessionId}`);
  }
  if (row.branch === null) {
    throw new CrossweaveError('LAND_NO_BRANCH', `Session ${row.name} has no branch to land (started with --no-worktree).`);
  }
  if (row.status === 'running' && !opts.force) {
    throw new CrossweaveError('SESSION_STILL_LIVE', `Session ${row.name} is running. Stop it first, or pass --force.`);
  }

  const base = currentBaseHead(deps.projectRoot);
  const integration = await ensureIntegrationWorktree(deps.db, workspaceId, deps.projectRoot);

  const trial = await runMergeTrial(integration.path, base, [row.branch]);
  if (trial.result === 'conflict') {
    resetIntegration(integration.path, base);
    throw new CrossweaveError(
      'LAND_CONFLICT',
      `Session ${row.name}'s branch conflicts with the current base: ${trial.detail ?? '(no files reported)'}`,
    );
  }

  let tested: 'clean' | 'unverified' = 'unverified';
  if (deps.config.converge.testCommand !== undefined) {
    const testOutcome = await withIntegrationLease(deps.leaseManager, integration.sessionId, async (env) => {
      const proc = Bun.spawn(['sh', '-c', deps.config.converge.testCommand as string], {
        cwd: integration.path, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe',
      });
      const [code, out, err] = await Promise.all([
        proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
      ]);
      return { code, tail: (out + err).slice(-4000) };
    });
    if (testOutcome.code !== 0) {
      resetIntegration(integration.path, base);
      throw new CrossweaveError('LAND_TEST_FAILED', `converge.testCommand failed:\n${testOutcome.tail}`);
    }
    tested = 'clean';
  }
  resetIntegration(integration.path, base);

  currentBaseBranch(deps.projectRoot); // refuses on a detached HEAD before any git mutation below

  const strategy = deps.config.converge.mergeStrategy;
  if (strategy === 'squash') {
    execFileSync('git', ['merge', '--squash', row.branch], { cwd: deps.projectRoot, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', `${row.name}: squashed from ${row.branch}`], { cwd: deps.projectRoot, stdio: 'ignore' });
  } else if (strategy === 'rebase') {
    // Rewritten in the scratch worktree — never the session's own branch,
    // and never the main checkout mid-operation — then fast-forwarded into
    // base. `git rebase <upstream> <branch>` checks `<branch>` out as a
    // side effect, which the integration worktree can absorb harmlessly
    // but the main checkout must not.
    execFileSync('git', ['checkout', '-B', 'cw/trial', row.branch], { cwd: integration.path, stdio: 'ignore' });
    execFileSync('git', ['rebase', base], { cwd: integration.path, stdio: 'ignore' });
    execFileSync('git', ['merge', '--ff-only', 'cw/trial'], { cwd: deps.projectRoot, stdio: 'ignore' });
    resetIntegration(integration.path, base);
  } else {
    execFileSync('git', ['merge', '--no-ff', row.branch, '-m', `Merge ${row.name} (${row.branch})`], {
      cwd: deps.projectRoot, stdio: 'ignore',
    });
  }

  deps.leaseManager.release(sessionId);
  const ownWorktree = row.worktreePath !== null && row.worktreePath !== deps.projectRoot ? row.worktreePath : null;
  if (ownWorktree !== null) {
    await removeWorktree(deps.projectRoot, ownWorktree).catch(() => undefined);
  }
  await deleteBranch(deps.projectRoot, row.branch).catch(() => undefined);

  deps.sessions.updateStatus(sessionId, 'landed', null);
  deps.ledger.append({ sessionId, workspaceId, kind: 'session.landed', payload: '{}' });

  return { status: 'landed', tested };
}
```

- [ ] **Step 3: Run to verify it passes**

Run: `bun test tests/convergence/land.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 4: Wire the `land.session` RPC**

In `src/daemon/methods.ts`:

```ts
import { landSession } from '../convergence/land.js';
```

```ts
    'land.session': async (p) => {
      const workspaceId = str(p, 'workspaceId');
      const target = sessions.resolve(workspaceId, str(p, 'idOrName'));
      return landSession(
        { db, projectRoot, sessions: sessionsRepo, leaseManager, ledger, config },
        workspaceId, target.id, { force: bool(p, 'force', false) },
      );
    },
```

Note: `buildMethods` currently constructs `sessions` as a `SessionManager`
(the domain wrapper), not the raw `SessionRepo` `landSession` needs. Add
`const sessionsRepo = new SessionRepo(db);` alongside the other repo
constructions near the top of `buildMethods`, and use it here — do not
thread `SessionManager` into `landSession`'s deps, since `landSession`
only ever needs plain row reads/status updates, matching the repo-level
access every other domain module in this codebase already uses directly.

- [ ] **Step 5: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: 0 errors, all green.

- [ ] **Step 6: Commit**

```bash
git add src/convergence/land.ts src/daemon/methods.ts tests/convergence/land.test.ts
git commit -m "feat(convergence): cw land mechanics — fresh trial, optional test run, merge to base"
```

---

### Task 7: `cw land` / `cw land --all` CLI

**Files:**
- Create: `src/cli/commands/land.ts`
- Modify: `src/cli/index.ts`
- Test: `tests/cli/land.test.ts`

**Interfaces:**
- Consumes: `land.session` RPC (Task 6), `converge.status` RPC (Task 5, for
  `--all`'s ordering).

- [ ] **Step 1: Write the failing CLI-parsing test**

`cw land`'s confirmation-gate logic (the part worth unit-testing without a
live daemon) mirrors `session.ts`'s `kill`/`rm` pattern exactly — a
client-side `CrossweaveError` thrown before any RPC call.

```ts
// tests/cli/land.test.ts
import { describe, expect, test } from 'bun:test';
import { assertLandConfirmed } from '../../src/cli/commands/land.js';

describe('assertLandConfirmed', () => {
  test('throws CONFIRMATION_REQUIRED when --yes is not passed', () => {
    expect(() => assertLandConfirmed(false)).toThrowError(
      expect.objectContaining({ code: 'CONFIRMATION_REQUIRED' }) as unknown as Error,
    );
  });

  test('does not throw when --yes is passed', () => {
    expect(() => assertLandConfirmed(true)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure, then implement**

Run: `bun test tests/cli/land.test.ts` — expect FAIL (module not found).

```ts
// src/cli/commands/land.ts
import { defineCommand } from 'citty';
import { CrossweaveError } from '../../core/errors.js';
import { withClient, fail, currentWorkspaceId } from '../context.js';

interface LandResult { status: string; tested: string }
interface ConvergeStatus { recommendedOrder: string[] }

export function assertLandConfirmed(yes: boolean): void {
  if (!yes) {
    throw new CrossweaveError(
      'CONFIRMATION_REQUIRED',
      'Landing merges the session\'s branch into the base branch and removes its worktree. Re-run with --yes.',
    );
  }
}

const singleCommand = defineCommand({
  meta: { name: 'session', description: "Land one session's branch into the base branch" },
  args: {
    target: { type: 'positional', description: 'Session name or id' },
    force: { type: 'boolean', default: false, description: 'Land even if the session is still running' },
    yes: { type: 'boolean', default: false, description: 'Skip confirmation' },
  },
  async run({ args }) {
    try {
      if (args.target === undefined) {
        throw new CrossweaveError('INVALID_ARGUMENTS', 'Missing required argument: TARGET');
      }
      assertLandConfirmed(args.yes);
      await withClient(async (client) => {
        const workspaceId = await currentWorkspaceId(client);
        const result = await client.call<LandResult>('land.session', {
          workspaceId, idOrName: args.target, force: args.force,
        });
        process.stdout.write(`landed ${args.target} (tested: ${result.tested})\n`);
      });
    } catch (err) { fail(err); }
  },
});

const allCommand = defineCommand({
  meta: { name: 'all', description: 'Land every conflict-free session, in recommended order, stopping at the first failure' },
  args: {
    force: { type: 'boolean', default: false, description: 'Land even sessions still running' },
    yes: { type: 'boolean', default: false, description: 'Skip confirmation' },
  },
  async run({ args }) {
    try {
      assertLandConfirmed(args.yes);
      await withClient(async (client) => {
        const workspaceId = await currentWorkspaceId(client);
        const status = await client.call<ConvergeStatus>('converge.status', { workspaceId });
        if (status.recommendedOrder.length === 0) {
          process.stdout.write('nothing to land\n');
          return;
        }
        for (const name of status.recommendedOrder) {
          try {
            const result = await client.call<LandResult>('land.session', {
              workspaceId, idOrName: name, force: args.force,
            });
            process.stdout.write(`landed ${name} (tested: ${result.tested})\n`);
          } catch (err) {
            process.stdout.write(`stopped at ${name}: ${(err as Error).message}\n`);
            throw err;
          }
        }
      });
    } catch (err) { fail(err); }
  },
});

export const landCommand = defineCommand({
  meta: { name: 'land', description: 'Merge a session\'s work into the base branch' },
  subCommands: { session: singleCommand, all: allCommand },
});
```

- [ ] **Step 3: Run to verify it passes**

Run: `bun test tests/cli/land.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 4: Register the subcommand**

In `src/cli/index.ts`:

```ts
import { landCommand } from './commands/land.js';
// ...
    land: landCommand,
```

- [ ] **Step 5: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: 0 errors, all green — this is the plan's last task, so this is
also the full-branch baseline the final whole-branch review will start
from.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/land.ts src/cli/index.ts tests/cli/land.test.ts
git commit -m "feat(cli): cw land session / cw land all"
```

---

## Post-plan note for the controller (not a task)

After the final whole-branch review, write
`docs/superpowers/specs/2026-08-11-m4-known-limitations.md` (matching the
M0–M3 precedent). Worth naming there: the deferred intent-aware
auto-resolver and Context Store "intent" capture; that `cw land --all`'s
per-session RPC calls are not wrapped in one atomic transaction (a crash
mid-sequence leaves some sessions landed and others not, which is
recoverable — re-running `cw land --all` just picks up where it left off —
but worth stating explicitly); and that the scheduler's in-memory
dedupe/debounce state (`lastTrialHead`, `triedPairs`, etc.) resets on daemon
restart, consistent with this project's established posture on other
in-memory state (Radar's `NotificationGate`, the daemon's `starting` set).
