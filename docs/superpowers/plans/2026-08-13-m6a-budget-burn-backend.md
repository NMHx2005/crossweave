# M6a — Budget/Burn Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give crossweave real, live per-session token and cost accounting — `cw session
list` shows actual spend, not the always-zero `tokenSpent: 0` M0 shipped — sourced from
both adapters: Claude Code's `statusLine` mechanism (T2) and ACP's native `usage_update`
(T1).

**Architecture:** One shared domain function, `recordUsage`, writes cumulative
tokens/cost onto a session's row. Two callers reach it: a new `session.reportUsage` RPC
(called by a new `cw session-usage-hook` CLI subcommand, wired into Claude Code's
`statusLine` setting) and `AcpAdapter`'s `session/update` handler calling it directly,
in-process — the same "one policy function, two transports" shape M5a/M5b already
established for `decideBlocked`. `cw session new` gains optional `--budget-tokens`/
`--budget-usd` flags; `cw session list` gains a spend column and a plain-text
over-budget marker. No auto-pause, no TUI — both are M6c's job.

**Tech Stack:** TypeScript, Bun, `bun:sqlite`, `@agentclientprotocol/sdk` (already a
dependency since M5b), `citty`.

**Spec:** `docs/superpowers/specs/2026-08-13-m6a-budget-burn-design.md`

## Global Constraints

- Bun >= 1.3.5, TypeScript strict mode — no `any`, `!`, `@ts-ignore` without a stated reason.
- `bun run typecheck` (tsc --noEmit) and `bun test` must both be clean before any task is done.
- Conventional Commits style messages (`feat:`, `fix:`, `test:`, `docs:`); one logical
  change per commit.
- Never commit to `main` — this plan runs entirely on a feature branch/worktree.
- Follow existing repo patterns exactly: repo files under `src/db/repositories/`, domain
  logic under `src/domain/`, adapters under `src/adapters/`, RPC handlers in
  `src/daemon/methods.ts`, CLI subcommands under `src/cli/commands/`, test fixtures
  under `tests/helpers/`.
- Both usage sources report **cumulative totals, not deltas** (design doc §2) —
  `recordUsage` and everything downstream of it must treat every value as "spend so
  far," never add to a running total itself.
- Neither usage source is authoritative billing data (design doc §2) — this must never
  be implied otherwise in any user-facing text this plan adds.
- No auto-pause, no OpenTUI, no per-turn granularity (design doc §1 non-goals) — out of
  scope for every task below.
- SCHEMA_VERSION goes from 7 to 8. `SessionRow` gains `costSpentUsd: number` and
  `costBudgetUsd: number | null`, mirroring `tokenSpent`/`tokenBudget` exactly (design
  doc §3.1).

---

### Task 1: Schema v8 — cost columns, `SessionRepo.updateUsage`, and the fixture sweep

Adds `cost_spent_usd`/`cost_budget_usd` to the `session` table, widens `SessionRow` to
match, and adds `SessionRepo.updateUsage` — the plain `UPDATE` every later task's
`recordUsage` writes through. Widening `SessionRow` with two new **required** fields
breaks every existing literal `SessionRow` object across the test suite (and two
production call sites) at compile time; this task's last step is a single mechanical
sweep that fixes all of them at once, verified by `bun run typecheck` going green.

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/repositories/session.ts`
- Modify: `tests/db/session-repo.test.ts`
- Modify (mechanical sweep, see Step 6): every other file under `tests/` and `src/`
  that constructs a `SessionRow` literal.

**Interfaces:**
- Consumes: nothing new.
- Produces: `SessionRow.costSpentUsd: number`, `SessionRow.costBudgetUsd: number |
  null`. `SessionRepo.updateUsage(id: string, usage: { tokensSpent?: number;
  costSpentUsd?: number }): void` — every later task's `recordUsage` (Task 2) writes
  through this.

- [ ] **Step 1: Write the failing tests**

In `tests/db/session-repo.test.ts`, find `makeRow`:

```ts
function makeRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: newId('s'),
    workspaceId,
    name: 'auth',
    agentKind: 'claude',
    adapter: 'claude-pty',
    status: 'idle',
    worktreePath: '/tmp/wt',
    branch: 'cw/auth',
    createdAt: '2026-08-09T00:00:00.000Z',
    lastActiveAt: '2026-08-09T00:00:00.000Z',
    tokenBudget: null,
    tokenSpent: 0,
    enforcementTier: 'T3',
    pid: null,
    ...overrides,
  };
}
```

Replace with:

```ts
function makeRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: newId('s'),
    workspaceId,
    name: 'auth',
    agentKind: 'claude',
    adapter: 'claude-pty',
    status: 'idle',
    worktreePath: '/tmp/wt',
    branch: 'cw/auth',
    createdAt: '2026-08-09T00:00:00.000Z',
    lastActiveAt: '2026-08-09T00:00:00.000Z',
    tokenBudget: null,
    tokenSpent: 0,
    costBudgetUsd: null,
    costSpentUsd: 0,
    enforcementTier: 'T3',
    pid: null,
    ...overrides,
  };
}
```

Then add these tests inside `describe('SessionRepo', ...)`, after the existing
`'round-trips a row'` test:

```ts
  it('round-trips cost columns', () => {
    const row = makeRow({ costBudgetUsd: 5, costSpentUsd: 1.2345 });
    repo.insert(row);
    expect(repo.findById(row.id)).toEqual(row);
  });

  it('updateUsage writes only the provided fields, leaving the other untouched', () => {
    const row = makeRow({ tokenSpent: 0, costSpentUsd: 0 });
    repo.insert(row);

    repo.updateUsage(row.id, { tokensSpent: 15500 });
    let after = repo.findById(row.id)!;
    expect(after.tokenSpent).toBe(15500);
    expect(after.costSpentUsd).toBe(0);

    repo.updateUsage(row.id, { costSpentUsd: 0.0123 });
    after = repo.findById(row.id)!;
    expect(after.tokenSpent).toBe(15500);
    expect(after.costSpentUsd).toBeCloseTo(0.0123);
  });

  it('updateUsage with both fields updates both together', () => {
    const row = makeRow();
    repo.insert(row);
    repo.updateUsage(row.id, { tokensSpent: 100, costSpentUsd: 0.5 });
    const after = repo.findById(row.id)!;
    expect(after.tokenSpent).toBe(100);
    expect(after.costSpentUsd).toBe(0.5);
  });

  it('updateUsage with neither field is a no-op', () => {
    const row = makeRow({ tokenSpent: 7, costSpentUsd: 0.1 });
    repo.insert(row);
    repo.updateUsage(row.id, {});
    const after = repo.findById(row.id)!;
    expect(after.tokenSpent).toBe(7);
    expect(after.costSpentUsd).toBe(0.1);
  });

  it('updateUsage against an unknown id is a silent no-op, not a throw', () => {
    expect(() => repo.updateUsage('s_ghost', { tokensSpent: 1 })).not.toThrow();
  });
```

- [ ] **Step 2: Run to verify the expected failures**

Run: `bun run typecheck`
Expected: FAIL — `Property 'costBudgetUsd' is missing in type` (the test file's
`makeRow` now claims a `SessionRow` shape the interface doesn't have yet), plus
`Property 'updateUsage' does not exist on type 'SessionRepo'`.

- [ ] **Step 3: Migrate the schema**

In `src/db/schema.ts`, find:

```ts
export const SCHEMA_VERSION = 7;
```

Replace with:

```ts
export const SCHEMA_VERSION = 8;
```

Find the end of the `MIGRATIONS` array (the `config_trust` migration block, the last
element):

```ts
  [
    // Trust gate for `converge.testCommand` (M4 known-limitation): a workspace
    // must explicitly `cw config trust` the exact command string sourced from
    // the committed crossweave.config.json before the daemon will ever execute
    // it. Keyed by a hash of the command string, not a boolean, so editing the
    // string — including via a hostile clone — requires re-trusting.
    `CREATE TABLE config_trust (
    workspace_id      TEXT PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
    test_command_hash TEXT NOT NULL,
    trusted_at        TEXT NOT NULL
  )`,
  ],
];
```

Replace with:

```ts
  [
    // Trust gate for `converge.testCommand` (M4 known-limitation): a workspace
    // must explicitly `cw config trust` the exact command string sourced from
    // the committed crossweave.config.json before the daemon will ever execute
    // it. Keyed by a hash of the command string, not a boolean, so editing the
    // string — including via a hostile clone — requires re-trusting.
    `CREATE TABLE config_trust (
    workspace_id      TEXT PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
    test_command_hash TEXT NOT NULL,
    trusted_at        TEXT NOT NULL
  )`,
  ],
  [
    // Budget/burn backend (M6a): cost accounting alongside the token accounting
    // M0 already had columns for but never wrote to. Independent, optional
    // budgets — a session can have a token budget, a cost budget, both, or
    // neither (design doc §3.1).
    `ALTER TABLE session ADD COLUMN cost_spent_usd REAL NOT NULL DEFAULT 0`,
    `ALTER TABLE session ADD COLUMN cost_budget_usd REAL`,
  ],
];
```

- [ ] **Step 4: Widen `SessionRow`/`SessionRepo`**

In `src/db/repositories/session.ts`, find:

```ts
export interface SessionRow {
  id: string;
  workspaceId: string;
  name: string;
  agentKind: string;
  adapter: string;
  status: SessionStatus;
  worktreePath: string | null;
  branch: string | null;
  createdAt: string;
  lastActiveAt: string;
  tokenBudget: number | null;
  tokenSpent: number;
  enforcementTier: EnforcementTier;
  pid: number | null;
}

interface SessionRecord {
  id: string;
  workspace_id: string;
  name: string;
  agent_kind: string;
  adapter: string;
  status: string;
  worktree_path: string | null;
  branch: string | null;
  created_at: string;
  last_active_at: string;
  token_budget: number | null;
  token_spent: number;
  enforcement_tier: string;
  pid: number | null;
}

const COLUMNS =
  'id, workspace_id, name, agent_kind, adapter, status, worktree_path, branch, ' +
  'created_at, last_active_at, token_budget, token_spent, enforcement_tier, pid';
```

Replace with:

```ts
export interface SessionRow {
  id: string;
  workspaceId: string;
  name: string;
  agentKind: string;
  adapter: string;
  status: SessionStatus;
  worktreePath: string | null;
  branch: string | null;
  createdAt: string;
  lastActiveAt: string;
  tokenBudget: number | null;
  tokenSpent: number;
  costBudgetUsd: number | null;
  costSpentUsd: number;
  enforcementTier: EnforcementTier;
  pid: number | null;
}

interface SessionRecord {
  id: string;
  workspace_id: string;
  name: string;
  agent_kind: string;
  adapter: string;
  status: string;
  worktree_path: string | null;
  branch: string | null;
  created_at: string;
  last_active_at: string;
  token_budget: number | null;
  token_spent: number;
  cost_budget_usd: number | null;
  cost_spent_usd: number;
  enforcement_tier: string;
  pid: number | null;
}

const COLUMNS =
  'id, workspace_id, name, agent_kind, adapter, status, worktree_path, branch, ' +
  'created_at, last_active_at, token_budget, token_spent, enforcement_tier, pid, ' +
  'cost_budget_usd, cost_spent_usd';
```

Find `toRow`:

```ts
function toRow(r: SessionRecord): SessionRow {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    agentKind: r.agent_kind,
    adapter: r.adapter,
    status: r.status as SessionStatus,
    worktreePath: r.worktree_path,
    branch: r.branch,
    createdAt: r.created_at,
    lastActiveAt: r.last_active_at,
    tokenBudget: r.token_budget,
    tokenSpent: r.token_spent,
    enforcementTier: r.enforcement_tier as EnforcementTier,
    pid: r.pid,
  };
}
```

Replace with:

```ts
function toRow(r: SessionRecord): SessionRow {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    agentKind: r.agent_kind,
    adapter: r.adapter,
    status: r.status as SessionStatus,
    worktreePath: r.worktree_path,
    branch: r.branch,
    createdAt: r.created_at,
    lastActiveAt: r.last_active_at,
    tokenBudget: r.token_budget,
    tokenSpent: r.token_spent,
    costBudgetUsd: r.cost_budget_usd,
    costSpentUsd: r.cost_spent_usd,
    enforcementTier: r.enforcement_tier as EnforcementTier,
    pid: r.pid,
  };
}
```

Find `insert`:

```ts
  insert(row: SessionRow): void {
    this.db
      .prepare(`INSERT INTO session (${COLUMNS}) VALUES (${'?, '.repeat(13)}?)`)
      .run(
        row.id, row.workspaceId, row.name, row.agentKind, row.adapter, row.status,
        row.worktreePath, row.branch, row.createdAt, row.lastActiveAt,
        row.tokenBudget, row.tokenSpent, row.enforcementTier, row.pid,
      );
  }
```

Replace with:

```ts
  insert(row: SessionRow): void {
    this.db
      .prepare(`INSERT INTO session (${COLUMNS}) VALUES (${'?, '.repeat(15)}?)`)
      .run(
        row.id, row.workspaceId, row.name, row.agentKind, row.adapter, row.status,
        row.worktreePath, row.branch, row.createdAt, row.lastActiveAt,
        row.tokenBudget, row.tokenSpent, row.enforcementTier, row.pid,
        row.costBudgetUsd, row.costSpentUsd,
      );
  }
```

Add `updateUsage`, right after `updateStatus`:

```ts
  updateStatus(id: string, status: SessionStatus, pid: number | null): void {
    this.db
      .prepare('UPDATE session SET status = ?, pid = ?, last_active_at = ? WHERE id = ?')
      .run(status, pid, new Date().toISOString(), id);
  }

  /**
   * Both usage sources (Claude Code's statusLine, ACP's usage_update) report
   * CUMULATIVE totals, not deltas — this writes whichever field(s) were provided
   * straight through, no arithmetic. Mirrors updateStatus's plain-UPDATE style.
   */
  updateUsage(id: string, usage: { tokensSpent?: number; costSpentUsd?: number }): void {
    const sets: string[] = [];
    const values: (string | number)[] = [];
    if (usage.tokensSpent !== undefined) {
      sets.push('token_spent = ?');
      values.push(usage.tokensSpent);
    }
    if (usage.costSpentUsd !== undefined) {
      sets.push('cost_spent_usd = ?');
      values.push(usage.costSpentUsd);
    }
    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE session SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }
```

- [ ] **Step 5: Run the new tests to verify they pass**

Run: `bun test tests/db/session-repo.test.ts`
Expected: all PASS.

- [ ] **Step 6: The mechanical sweep — every other `SessionRow` literal**

Widening `SessionRow` with two required fields breaks every other file that builds one
by hand. Verify the exact scope first:

Run: `grep -rln "tokenSpent: 0," tests/ src/`
Expected: a list of files. Every one of them constructs a `SessionRow`-shaped object
literal containing the substring `tokenSpent: 0,` immediately followed by either
another field on the same line (e.g. `enforcementTier: 'T3',`) or a newline before the
next field — in both cases, inserting new fields directly after `tokenSpent: 0,` on the
same line is a safe, minimal, mechanical fix that does not need per-file judgment.

Fix every one of them in a single pass:

```bash
grep -rl "tokenSpent: 0," tests/ src/ | xargs sed -i '' 's/tokenSpent: 0,/tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null,/g'
```

(macOS/BSD `sed -i ''` — this repo's platform is Darwin. If running on Linux, use
`sed -i` without the trailing `''`.)

This is deliberately a blunt default-value sweep: `costSpentUsd: 0, costBudgetUsd:
null` is correct for every one of these sites in isolation — they are all either test
fixtures seeding a session that starts with no spend and no cost budget, or two
production call sites (`src/domain/session.ts`'s `SessionManager.create` and
`src/convergence/integration-worktree.ts`'s integration-session row) that also
legitimately start a new session at zero spend. Task 6 revisits `SessionManager.create`
specifically to thread a real `costBudgetUsd` through from `--budget-usd`; every other
site this sweep touches needs no further change.

Run: `bun run typecheck`
Expected: 0 errors. If any remain, they are sites the grep above did not catch (e.g. a
`SessionRow` built with a variable instead of the literal `0`, or different spacing) —
open each reported file:line, and add `costSpentUsd: <appropriate value, usually 0>,
costBudgetUsd: <appropriate value, usually null>,` next to that file's existing
`tokenSpent`/`tokenBudget` fields, matching its own style.

- [ ] **Step 7: Full suite**

Run: `bun test`
Expected: all PASS. The sweep only added default values; no existing behavior changed.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(db): schema v8 — cost_spent_usd/cost_budget_usd columns, SessionRepo.updateUsage

Independent, optional cost accounting alongside the existing token
columns (design doc §3.1). SessionRow's two new required fields
break every existing SessionRow literal at compile time; fixed by a
single mechanical default-value sweep (costSpentUsd: 0,
costBudgetUsd: null) verified by bun run typecheck going green."
```

---

### Task 2: `recordUsage` — the shared domain function

The one place both usage sources (the statusLine hook, ACP's `usage_update`) funnel
through. Mirrors `decideBlocked`'s (`src/radar/decision.ts`) established M5a/M5b shape:
one plain function, tested in isolation against a seeded `SessionRepo`.

**Files:**
- Create: `src/domain/usage.ts`
- Create: `tests/domain/usage.test.ts`

**Interfaces:**
- Consumes: `SessionRepo.updateUsage` (Task 1).
- Produces: `recordUsage(deps: RecordUsageDeps, params: RecordUsageParams): void` —
  `RecordUsageDeps = { sessions: SessionRepo }`, `RecordUsageParams = { sessionId:
  string; tokensUsed?: number; costUsd?: number }`. Task 3's RPC handler and Task 5's
  `AcpAdapter` both call this directly.

- [ ] **Step 1: Write the failing test**

Create `tests/domain/usage.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';
import { recordUsage } from '../../src/domain/usage.js';

describe('recordUsage', () => {
  function seed(): SessionRepo {
    const db = openDatabase(':memory:');
    new WorkspaceRepo(db).insert({
      id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
      defaultIsolation: 'worktree', safeModeTier: 'T2',
    });
    const sessions = new SessionRepo(db);
    sessions.insert({
      id: 's_1', workspaceId: 'ws_1', name: 's_1', agentKind: 'claude', adapter: 'claude',
      status: 'running', worktreePath: '/tmp/w/s_1', branch: 'cw/s_1', createdAt: 'now',
      lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costBudgetUsd: null,
      costSpentUsd: 0, enforcementTier: 'T2', pid: null,
    });
    return sessions;
  }

  test('tokens-only update leaves cost untouched', () => {
    const sessions = seed();
    recordUsage({ sessions }, { sessionId: 's_1', tokensUsed: 15500 });
    const row = sessions.findById('s_1')!;
    expect(row.tokenSpent).toBe(15500);
    expect(row.costSpentUsd).toBe(0);
  });

  test('cost-only update leaves tokens untouched', () => {
    const sessions = seed();
    recordUsage({ sessions }, { sessionId: 's_1', costUsd: 0.01234 });
    const row = sessions.findById('s_1')!;
    expect(row.costSpentUsd).toBeCloseTo(0.01234);
    expect(row.tokenSpent).toBe(0);
  });

  test('both fields update together', () => {
    const sessions = seed();
    recordUsage({ sessions }, { sessionId: 's_1', tokensUsed: 100, costUsd: 0.5 });
    const row = sessions.findById('s_1')!;
    expect(row.tokenSpent).toBe(100);
    expect(row.costSpentUsd).toBe(0.5);
  });

  test('neither field provided is a no-op', () => {
    const sessions = seed();
    recordUsage({ sessions }, { sessionId: 's_1' });
    const row = sessions.findById('s_1')!;
    expect(row.tokenSpent).toBe(0);
    expect(row.costSpentUsd).toBe(0);
  });

  test('an unknown sessionId does not throw', () => {
    const sessions = seed();
    expect(() => recordUsage({ sessions }, { sessionId: 's_ghost', tokensUsed: 1 })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/domain/usage.test.ts`
Expected: FAIL — `Cannot find module '../../src/domain/usage.js'` (doesn't exist yet).

- [ ] **Step 3: Implement `src/domain/usage.ts`**

```ts
import type { SessionRepo } from '../db/repositories/session.js';

export interface RecordUsageDeps {
  sessions: SessionRepo;
}

export interface RecordUsageParams {
  sessionId: string;
  /** Cumulative, not a delta — both usage sources report a running total (design doc §2). */
  tokensUsed?: number;
  /** Cumulative, not a delta. Not authoritative billing data — a client-side estimate. */
  costUsd?: number;
}

/**
 * The one place both usage sources — Claude Code's statusLine (via the
 * session.reportUsage RPC, Task 3) and ACP's usage_update (via AcpAdapter, in-process,
 * Task 5) — funnel through, mirroring decideBlocked's (src/radar/decision.ts)
 * established M5a/M5b shape: one plain function, two callers, one policy defined once.
 * An unknown sessionId is a silent no-op (SessionRepo.updateUsage's own contract) —
 * usage reporting is best-effort observability, not a safety decision, so it must
 * never throw and break the caller's hot path.
 */
export function recordUsage(deps: RecordUsageDeps, params: RecordUsageParams): void {
  deps.sessions.updateUsage(params.sessionId, {
    tokensSpent: params.tokensUsed,
    costSpentUsd: params.costUsd,
  });
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test tests/domain/usage.test.ts`
Expected: all PASS.

- [ ] **Step 5: Full suite and typecheck**

Run: `bun run typecheck && bun test`
Expected: 0 typecheck errors; full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/domain/usage.ts tests/domain/usage.test.ts
git commit -m "feat(domain): recordUsage — shared usage-accounting function

One function, two callers (session.reportUsage RPC, AcpAdapter
in-process) — mirrors decideBlocked's established M5a/M5b shape.
Both usage sources report cumulative totals, not deltas; this writes
whichever field(s) were provided straight through, no arithmetic."
```

---

### Task 3: `session.reportUsage` RPC

The RPC handler `cw session-usage-hook` (Task 4) calls over the daemon socket, the same
way `cw radar-hook` calls `radar.check`.

**Files:**
- Modify: `src/daemon/methods.ts`
- Create: `tests/daemon/methods-usage.test.ts`

**Interfaces:**
- Consumes: `recordUsage` (Task 2, `src/domain/usage.js`).
- Produces: RPC method `'session.reportUsage'`, params `{ sessionId: string;
  tokensUsed?: number; costUsd?: number }`, returns `{ ok: true }`.

- [ ] **Step 1: Write the failing test**

Create `tests/daemon/methods-usage.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { SessionRepo } from '../../src/db/repositories/session.js';

function seed() {
  const db = openDatabase(':memory:');
  new WorkspaceRepo(db).insert({
    id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
    defaultIsolation: 'worktree', safeModeTier: 'T2',
  });
  const sessions = new SessionRepo(db);
  sessions.insert({
    id: 's_1', workspaceId: 'ws_1', name: 's_1', agentKind: 'claude', adapter: 'claude',
    status: 'running', worktreePath: '/tmp/w/s_1', branch: 'cw/s_1', createdAt: 'now',
    lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costBudgetUsd: null,
    costSpentUsd: 0, enforcementTier: 'T2', pid: null,
  });
  return { db, sessions };
}

const ctx = { notify: () => undefined, onClose: () => undefined };

describe('session.reportUsage RPC', () => {
  test('writes tokensUsed and costUsd to the session row', async () => {
    const { db, sessions } = seed();
    const methods = buildMethods(db, '/tmp/w');
    const result = await methods['session.reportUsage']!(
      { sessionId: 's_1', tokensUsed: 16700, costUsd: 0.0123 }, ctx,
    );
    expect(result).toEqual({ ok: true });
    const row = sessions.findById('s_1')!;
    expect(row.tokenSpent).toBe(16700);
    expect(row.costSpentUsd).toBeCloseTo(0.0123);
  });

  test('tokensUsed only: costSpentUsd stays at its previous value', async () => {
    const { db, sessions } = seed();
    const methods = buildMethods(db, '/tmp/w');
    await methods['session.reportUsage']!({ sessionId: 's_1', tokensUsed: 500 }, ctx);
    const row = sessions.findById('s_1')!;
    expect(row.tokenSpent).toBe(500);
    expect(row.costSpentUsd).toBe(0);
  });

  test('an unknown sessionId does not throw', async () => {
    const { db } = seed();
    const methods = buildMethods(db, '/tmp/w');
    const result = await methods['session.reportUsage']!({ sessionId: 's_ghost', tokensUsed: 1 }, ctx);
    expect(result).toEqual({ ok: true });
  });

  test('missing sessionId param throws INVALID_PARAMS', async () => {
    const { db } = seed();
    const methods = buildMethods(db, '/tmp/w');
    await expect(methods['session.reportUsage']!({}, ctx)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify the expected failures**

Run: `bun test tests/daemon/methods-usage.test.ts`
Expected: FAIL — `methods['session.reportUsage']` is `undefined` (no such handler yet).

- [ ] **Step 3: Implement the handler**

In `src/daemon/methods.ts`, add this import alongside the others:

```ts
import { recordUsage } from '../domain/usage.js';
```

Find the `num` helper:

```ts
function num(params: Record<string, unknown>, key: string): number {
  const v = params[key];
  if (typeof v !== 'number') {
    throw new CrossweaveError('INVALID_PARAMS', `Expected number param: ${key}`);
  }
  return v;
}
```

Add `optionalNum` right after it:

```ts
function optionalNum(params: Record<string, unknown>, key: string): number | undefined {
  const v = params[key];
  return typeof v === 'number' ? v : undefined;
}
```

Find `'session.resize'`'s handler and the `'session.stop'` handler that follows it:

```ts
    'session.resize': (p) => {
      const row = sessions.resolve(str(p, 'workspaceId'), str(p, 'idOrName'));
      runtime.resize(row.id, row.name, num(p, 'cols'), num(p, 'rows'));
      return { ok: true };
    },

    // Awaited, so a caller told the session stopped can trust that it actually is.
    'session.stop': async (p) => {
```

Replace with:

```ts
    'session.resize': (p) => {
      const row = sessions.resolve(str(p, 'workspaceId'), str(p, 'idOrName'));
      runtime.resize(row.id, row.name, num(p, 'cols'), num(p, 'rows'));
      return { ok: true };
    },

    // No workspaceId in the params, deliberately: this is a high-frequency,
    // best-effort call (Claude Code's statusLine fires after every assistant
    // message, debounced 300ms) and the caller already knows the exact session
    // id — resolving through `sessions.resolve` would add a workspace lookup with
    // no purpose. An unknown sessionId is a silent no-op (recordUsage's own
    // contract), matching this call's "never block the agent" bar.
    'session.reportUsage': (p) => {
      recordUsage({ sessions: sessionsRepo }, {
        sessionId: str(p, 'sessionId'),
        tokensUsed: optionalNum(p, 'tokensUsed'),
        costUsd: optionalNum(p, 'costUsd'),
      });
      return { ok: true };
    },

    // Awaited, so a caller told the session stopped can trust that it actually is.
    'session.stop': async (p) => {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/daemon/methods-usage.test.ts`
Expected: all PASS.

- [ ] **Step 5: Full suite and typecheck**

Run: `bun run typecheck && bun test`
Expected: 0 typecheck errors; full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/methods.ts tests/daemon/methods-usage.test.ts
git commit -m "feat(daemon): session.reportUsage RPC

Calls recordUsage directly. The hot-path, best-effort caller (cw
session-usage-hook, Task 4) needs only a session id already known
from CW_SESSION_ID — no workspace resolution, and an unknown session
id is a silent no-op rather than a throw."
```

---

### Task 4: `cw session-usage-hook` — the Claude Code statusLine command

New CLI subcommand, structured like `cw radar-hook`: reads the statusLine JSON from
stdin, extracts `cost.total_cost_usd` and the combined context-window token count,
calls `session.reportUsage`, and prints one short line back for Claude Code to render
as the visible status line. `radarHookSettings()` in `src/adapters/claude-pty.ts` gains
a `statusLine` entry alongside the existing `hooks.PreToolUse` entry.

The exact statusLine JSON contract (settings shape and stdin payload field names) was
verified 2026-08-13 against Claude Code's own docs
(`https://code.claude.com/docs/en/statusline`) — settings shape is `{ statusLine: {
type: "command", command: "..." } }`; the stdin payload carries `cwd`, `cost.total_cost_usd`,
and `context_window.total_input_tokens`/`context_window.total_output_tokens` (both
cumulative for the session, not deltas) among other fields this plan does not use.

**Files:**
- Create: `src/cli/commands/session-usage-hook.ts`
- Create: `tests/cli/session-usage-hook.test.ts`
- Modify: `src/adapters/claude-pty.ts`
- Modify: `tests/adapters/claude-pty.test.ts`
- Modify: `src/cli/index.ts`

**Interfaces:**
- Consumes: `resolveMainProjectRoot` (existing, `src/cli/commands/radar-hook.js`),
  `connectOrStart` (existing, `src/client/rpc-client.js`), `loadConfig` (existing,
  `src/core/config.js`).
- Produces: `runSessionUsageHook(stdin: string, sessionId: string | undefined, report:
  ReportUsageFn): Promise<string>` — `ReportUsageFn = (cwd: string, sessionId: string,
  tokensUsed: number | undefined, costUsd: number | undefined) => Promise<void>`.
  Exported for direct testing, mirroring `runRadarHook`. `sessionId` is passed in
  (resolved from `process.env.CW_SESSION_ID` by the CLI command's `run()`) rather than
  read from `process.env` inside the testable function itself, so the "missing
  CW_SESSION_ID" degrade path is directly testable without mutating global env state.

- [ ] **Step 1: Write the failing tests**

Create `tests/cli/session-usage-hook.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { runSessionUsageHook, type ReportUsageFn } from '../../src/cli/commands/session-usage-hook.js';

function stdinFor(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    cwd: '/tmp/w',
    cost: { total_cost_usd: 0.01234 },
    context_window: { total_input_tokens: 15500, total_output_tokens: 1200 },
    ...overrides,
  });
}

describe('runSessionUsageHook', () => {
  test('valid payload reports cost + combined tokens and prints a status line', async () => {
    let reported: [string, string, number | undefined, number | undefined] | undefined;
    const report: ReportUsageFn = async (cwd, sessionId, tokensUsed, costUsd) => {
      reported = [cwd, sessionId, tokensUsed, costUsd];
    };
    const out = await runSessionUsageHook(stdinFor(), 's_1', report);
    expect(reported).toEqual(['/tmp/w', 's_1', 16700, 0.01234]);
    expect(out).toBe('$0.0123 · 16.7k tokens');
  });

  test('missing CW_SESSION_ID (sessionId undefined): no report call, empty output, no throw', async () => {
    let called = false;
    const report: ReportUsageFn = async () => { called = true; };
    const out = await runSessionUsageHook(stdinFor(), undefined, report);
    expect(called).toBe(false);
    expect(out).toBe('');
  });

  test('malformed JSON: no report call, empty output, no throw', async () => {
    let called = false;
    const report: ReportUsageFn = async () => { called = true; };
    const out = await runSessionUsageHook('not json at all', 's_1', report);
    expect(called).toBe(false);
    expect(out).toBe('');
  });

  test('valid JSON that is not an object (e.g. `null`): empty output, no throw', async () => {
    const out = await runSessionUsageHook('null', 's_1', async () => {});
    expect(out).toBe('');
  });

  test('missing cwd field: no report call, empty output', async () => {
    let called = false;
    const report: ReportUsageFn = async () => { called = true; };
    const out = await runSessionUsageHook(stdinFor({ cwd: undefined }), 's_1', report);
    expect(called).toBe(false);
    expect(out).toBe('');
  });

  test('an unreachable daemon (report throws): degrades to empty output, never crashes', async () => {
    const report: ReportUsageFn = async () => { throw new Error('daemon unreachable'); };
    const out = await runSessionUsageHook(stdinFor(), 's_1', report);
    expect(out).toBe('');
  });

  test('cost only (no context_window): reports cost, formats a cost-only status line', async () => {
    let reported: [string, string, number | undefined, number | undefined] | undefined;
    const report: ReportUsageFn = async (cwd, sessionId, tokensUsed, costUsd) => {
      reported = [cwd, sessionId, tokensUsed, costUsd];
    };
    const out = await runSessionUsageHook(stdinFor({ context_window: undefined }), 's_1', report);
    expect(reported).toEqual(['/tmp/w', 's_1', undefined, 0.01234]);
    expect(out).toBe('$0.0123');
  });

  test('neither cost nor context_window present: no report call, empty output', async () => {
    let called = false;
    const report: ReportUsageFn = async () => { called = true; };
    const out = await runSessionUsageHook(stdinFor({ cost: undefined, context_window: undefined }), 's_1', report);
    expect(called).toBe(false);
    expect(out).toBe('');
  });
});
```

- [ ] **Step 2: Run to verify the expected failures**

Run: `bun test tests/cli/session-usage-hook.test.ts`
Expected: FAIL — `Cannot find module '../../src/cli/commands/session-usage-hook.js'`
(doesn't exist yet).

- [ ] **Step 3: Implement `src/cli/commands/session-usage-hook.ts`**

```ts
import { defineCommand } from 'citty';
import { loadConfig } from '../../core/config.js';
import { connectOrStart } from '../../client/rpc-client.js';
import { resolveMainProjectRoot } from './radar-hook.js';

interface StatusLineInput {
  cwd?: unknown;
  cost?: { total_cost_usd?: unknown };
  context_window?: { total_input_tokens?: unknown; total_output_tokens?: unknown };
}

export type ReportUsageFn = (
  cwd: string, sessionId: string, tokensUsed: number | undefined, costUsd: number | undefined,
) => Promise<void>;

function formatStatusLine(tokensUsed: number | undefined, costUsd: number | undefined): string {
  const parts: string[] = [];
  if (costUsd !== undefined) parts.push(`$${costUsd.toFixed(4)}`);
  if (tokensUsed !== undefined) parts.push(`${(tokensUsed / 1000).toFixed(1)}k tokens`);
  return parts.join(' · ');
}

/**
 * Exported for direct testing — see tests/cli/session-usage-hook.test.ts. Never
 * throws: a broken statusLine command must not block the agent or crash Claude
 * Code's status line renderer (same "never block the agent" bar cw radar-hook meets).
 * `sessionId` is passed in already resolved (from CW_SESSION_ID by the caller below)
 * rather than read from process.env here, so the missing-session-id degrade path is
 * directly testable. `cwd` is read from the JSON payload itself, not process.cwd() —
 * same reasoning as runRadarHook: the statusLine command's own cwd could be reached
 * through a symlink or otherwise not match what resolveMainProjectRoot needs.
 */
export async function runSessionUsageHook(
  stdin: string,
  sessionId: string | undefined,
  report: ReportUsageFn,
): Promise<string> {
  let input: StatusLineInput;
  try {
    input = JSON.parse(stdin) as StatusLineInput;
  } catch {
    return '';
  }
  if (typeof input !== 'object' || input === null) return '';
  if (sessionId === undefined) return '';

  const cwd = typeof input.cwd === 'string' ? input.cwd : undefined;
  if (cwd === undefined) return '';

  const costUsd = typeof input.cost?.total_cost_usd === 'number' ? input.cost.total_cost_usd : undefined;
  const inputTokens =
    typeof input.context_window?.total_input_tokens === 'number' ? input.context_window.total_input_tokens : undefined;
  const outputTokens =
    typeof input.context_window?.total_output_tokens === 'number' ? input.context_window.total_output_tokens : undefined;
  const tokensUsed = inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined;

  if (costUsd === undefined && tokensUsed === undefined) return '';

  try {
    await report(cwd, sessionId, tokensUsed, costUsd);
  } catch {
    return ''; // daemon unreachable, RPC failed, etc. — degrade silently, never crash the status line
  }

  return formatStatusLine(tokensUsed, costUsd);
}

export const sessionUsageHookCommand = defineCommand({
  meta: { name: 'session-usage-hook', description: "Internal: Claude Code's statusLine entry point" },
  async run() {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const stdin = Buffer.concat(chunks).toString('utf8');

    const out = await runSessionUsageHook(stdin, process.env.CW_SESSION_ID, async (cwd, sessionId, tokensUsed, costUsd) => {
      const projectRoot = resolveMainProjectRoot(cwd);
      loadConfig(projectRoot);
      const client = await connectOrStart(projectRoot);
      try {
        await client.call('session.reportUsage', { sessionId, tokensUsed, costUsd });
      } finally {
        client.close();
      }
    });

    process.stdout.write(out);
  },
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/cli/session-usage-hook.test.ts`
Expected: all PASS.

- [ ] **Step 5: Wire the CLI command into `cw`**

In `src/cli/index.ts`, find:

```ts
import { radarHookCommand } from './commands/radar-hook.js';
```

Replace with:

```ts
import { radarHookCommand } from './commands/radar-hook.js';
import { sessionUsageHookCommand } from './commands/session-usage-hook.js';
```

Find:

```ts
    'radar-hook': radarHookCommand,
```

Replace with:

```ts
    'radar-hook': radarHookCommand,
    'session-usage-hook': sessionUsageHookCommand,
```

- [ ] **Step 6: Write the failing test for `radarHookSettings()`'s new `statusLine` entry**

In `tests/adapters/claude-pty.test.ts`, find:

```ts
interface RadarHookSettings {
  hooks: { PreToolUse: [{ matcher: string; hooks: [{ type: string; command: string; timeout: number }] }] };
}
```

Replace with:

```ts
interface RadarHookSettings {
  hooks: { PreToolUse: [{ matcher: string; hooks: [{ type: string; command: string; timeout: number }] }] };
  statusLine: { type: string; command: string };
}
```

Add this test right after `'spawn injects a scoped PreToolUse hook via --settings, calling cw radar-hook'`:

```ts
  it('spawn also injects a statusLine command, calling cw session-usage-hook', async () => {
    const settings = await spawnAndReadRadarHookSettings();
    expect(settings.statusLine.type).toBe('command');
    expect(settings.statusLine.command).toContain('session-usage-hook');
  });
```

- [ ] **Step 7: Run to verify the expected failure**

Run: `bun test tests/adapters/claude-pty.test.ts`
Expected: FAIL — `settings.statusLine` is `undefined` (`radarHookSettings()` doesn't
emit it yet).

- [ ] **Step 8: Implement it**

In `src/adapters/claude-pty.ts`, find the doc comment above `radarHookInvocation`
together with the function itself:

```ts
/**
 * The full shell command that invokes `cw radar-hook` — `spawn` runs inside
 * the daemon process, whose PATH is whatever the client forwarded (see
 * `clientEnv` in methods.ts), which may not include wherever `cw` itself was
 * installed, so this cannot just be the bare command name in every case.
 *
 * Three tiers, most to least specific, mirroring `resolveDaemonEntry` in
 * `client/rpc-client.ts` (same compiled-vs-source problem, same fix):
 * 1. In a COMPILED build, `process.execPath` is this very `cwd` binary's own
 *    path (a Bun-compiled standalone executable reports itself, not the Bun
 *    runtime) — `scripts/build.ts` always places `cw` and `cwd` side by
 *    side, so a sibling `cw` next to it is the release layout, and that
 *    sibling IS directly executable.
 * 2. In DEV (`bun run`), `process.execPath` is wherever `bun` itself lives,
 *    which tier 1 would resolve wrongly — `import.meta.url` instead points
 *    at this module's own real source location, and `cw`'s entry point is
 *    the sibling `src/cli/index.ts`. That source file is checked into git
 *    WITHOUT an executable bit, so it cannot be run directly — the command
 *    must go through the interpreter that is currently running this very
 *    process (`process.execPath`, i.e. `bun`), with the source path passed
 *    as its argument, exactly like `resolveDaemonEntry` does for the
 *    daemon's own source-mode case.
 * 3. Neither guess matches (e.g. a global install with the two binaries in
 *    different directories) — fall back to the bare command name and let
 *    PATH resolve it, same as any other sibling-CLI convention.
 */
function radarHookInvocation(): string {
  const siblingOfExecutable = join(dirname(process.execPath), 'cw');
  if (existsSync(siblingOfExecutable)) return `${siblingOfExecutable} radar-hook`;

  const siblingSource = fileURLToPath(new URL('../cli/index.ts', import.meta.url));
  if (existsSync(siblingSource)) return `${process.execPath} ${siblingSource} radar-hook`;

  return 'cw radar-hook';
}

function radarHookSettings(): string {
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: '^(Edit|Write)$',
          hooks: [{ type: 'command', command: radarHookInvocation(), timeout: 5 }],
        },
      ],
    },
  });
}
```

Replace with:

```ts
/**
 * The full shell command that invokes a `cw` subcommand — `spawn` runs inside
 * the daemon process, whose PATH is whatever the client forwarded (see
 * `clientEnv` in methods.ts), which may not include wherever `cw` itself was
 * installed, so this cannot just be the bare command name in every case.
 * Generalized from M3's `radarHookInvocation` (same three-tier resolution, now
 * parameterized by subcommand) so M6a's statusLine command can reuse it instead of
 * duplicating the resolution logic.
 *
 * Three tiers, most to least specific, mirroring `resolveDaemonEntry` in
 * `client/rpc-client.ts` (same compiled-vs-source problem, same fix):
 * 1. In a COMPILED build, `process.execPath` is this very `cwd` binary's own
 *    path (a Bun-compiled standalone executable reports itself, not the Bun
 *    runtime) — `scripts/build.ts` always places `cw` and `cwd` side by
 *    side, so a sibling `cw` next to it is the release layout, and that
 *    sibling IS directly executable.
 * 2. In DEV (`bun run`), `process.execPath` is wherever `bun` itself lives,
 *    which tier 1 would resolve wrongly — `import.meta.url` instead points
 *    at this module's own real source location, and `cw`'s entry point is
 *    the sibling `src/cli/index.ts`. That source file is checked into git
 *    WITHOUT an executable bit, so it cannot be run directly — the command
 *    must go through the interpreter that is currently running this very
 *    process (`process.execPath`, i.e. `bun`), with the source path passed
 *    as its argument, exactly like `resolveDaemonEntry` does for the
 *    daemon's own source-mode case.
 * 3. Neither guess matches (e.g. a global install with the two binaries in
 *    different directories) — fall back to the bare command name and let
 *    PATH resolve it, same as any other sibling-CLI convention.
 */
function cwInvocation(subcommand: string): string {
  const siblingOfExecutable = join(dirname(process.execPath), 'cw');
  if (existsSync(siblingOfExecutable)) return `${siblingOfExecutable} ${subcommand}`;

  const siblingSource = fileURLToPath(new URL('../cli/index.ts', import.meta.url));
  if (existsSync(siblingSource)) return `${process.execPath} ${siblingSource} ${subcommand}`;

  return `cw ${subcommand}`;
}

function radarHookSettings(): string {
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: '^(Edit|Write)$',
          hooks: [{ type: 'command', command: cwInvocation('radar-hook'), timeout: 5 }],
        },
      ],
    },
    // M6a: reuses the exact same --settings JSON crossweave already injects for the
    // PreToolUse hook (design doc §2) — no new spawn-time surface.
    statusLine: {
      type: 'command',
      command: cwInvocation('session-usage-hook'),
    },
  });
}
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `bun test tests/adapters/claude-pty.test.ts`
Expected: all PASS.

- [ ] **Step 10: Full suite and typecheck**

Run: `bun run typecheck && bun test`
Expected: 0 typecheck errors; full suite green.

- [ ] **Step 11: Commit**

```bash
git add src/cli/commands/session-usage-hook.ts tests/cli/session-usage-hook.test.ts \
  src/adapters/claude-pty.ts tests/adapters/claude-pty.test.ts src/cli/index.ts
git commit -m "feat(cli): cw session-usage-hook — Claude Code statusLine entry point

Wired into radarHookSettings()'s existing --settings JSON alongside
the PreToolUse hook. Reads cost.total_cost_usd and the combined
context_window token count from stdin, reports via
session.reportUsage, and prints one short line back for Claude Code
to render. Never throws — malformed input, a missing CW_SESSION_ID,
or an unreachable daemon all degrade to printing nothing."
```

---

### Task 5: `AcpAdapter` — handle `usage_update`

Wires ACP's native `usage_update` session-update variant to `recordUsage`, in-process,
no RPC — the same reasoning M5b used for the permission handler calling `decideBlocked`
directly.

**Files:**
- Modify: `src/adapters/acp.ts`
- Modify: `tests/adapters/acp.test.ts`
- Modify: `tests/adapters/acp-integration.test.ts`
- Modify: `tests/adapters/registry.test.ts`
- Modify: `tests/helpers/fake-acp-agent.ts`
- Modify: `src/daemon/methods.ts`

**Interfaces:**
- Consumes: `recordUsage`/`RecordUsageParams` (Task 2, `src/domain/usage.js`).
- Produces: `AcpAdapterDeps` gains `recordUsage(params: RecordUsageParams): void`.
  `src/daemon/methods.ts`'s `cursorDeps` wires it to the real `recordUsage` +
  `sessionsRepo`.

- [ ] **Step 1: Add the `__USAGE_UPDATE__` marker to the fake ACP agent**

In `tests/helpers/fake-acp-agent.ts`, find:

```ts
  const marker = '__REQUEST_PERMISSION__:';
  if (text.startsWith(marker)) {
```

Add this block right before it:

```ts
  const usageMarker = '__USAGE_UPDATE__:';
  if (text.startsWith(usageMarker)) {
    const parsed = JSON.parse(text.slice(usageMarker.length)) as {
      used: number;
      size: number;
      cost?: { amount: number; currency: string };
    };
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: 'usage_update', used: parsed.used, size: parsed.size, cost: parsed.cost },
    });
    await sendText(cx, sessionId, 'USAGE_REPORTED');
    return { stopReason: 'end_turn' };
  }

  const marker = '__REQUEST_PERMISSION__:';
  if (text.startsWith(marker)) {
```

- [ ] **Step 2: Write the failing tests**

In `tests/adapters/acp.test.ts`, find:

```ts
import { AcpAdapter } from '../../src/adapters/acp.js';
import type { DecideBlockedParams, DecideBlockedResult } from '../../src/radar/decision.js';
```

Replace with:

```ts
import { AcpAdapter } from '../../src/adapters/acp.js';
import type { DecideBlockedParams, DecideBlockedResult } from '../../src/radar/decision.js';
import type { RecordUsageParams } from '../../src/domain/usage.js';
```

Widen `NOOP_DEPS` and every other deps literal in this file with a no-op
`recordUsage` — every one of them shares the exact substring `resolveWorkspaceId: () =>
'ws_1',` immediately followed by `decideBlocked`, so a single sweep fixes all 11:

Run:

```bash
sed -i '' "s/resolveWorkspaceId: () => 'ws_1', decideBlocked/resolveWorkspaceId: () => 'ws_1', recordUsage: () => {}, decideBlocked/g" tests/adapters/acp.test.ts
```

(macOS/BSD `sed -i ''`.)

Then add these tests inside `describe('AcpAdapter', ...)`, after the existing `'a
tool_call/tool_call_update pair renders as a readable bracketed line via onData'` test:

```ts
  it('a usage_update notification calls recordUsage with tokens and cost', async () => {
    const seen: RecordUsageParams[] = [];
    const adapter = new AcpAdapter(
      {
        resolveWorkspaceId: () => 'ws_1',
        decideBlocked: () => ({ collisions: [], blocked: false }),
        recordUsage: (params) => { seen.push(params); },
      },
      process.execPath, [FAKE_AGENT],
    );
    const proc = adapter.spawn({ cwd: process.cwd(), env: { CW_SESSION_ID: 's_1' }, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write(`__USAGE_UPDATE__:${JSON.stringify({ used: 16700, size: 200000, cost: { amount: 0.0123, currency: 'USD' } })}`);
    await waitFor(() => read().includes('USAGE_REPORTED'));
    expect(seen).toEqual([{ sessionId: 's_1', tokensUsed: 16700, costUsd: 0.0123 }]);
    proc.kill();
  });

  it('a usage_update with no cost field: recordUsage gets tokens only, costUsd undefined', async () => {
    const seen: RecordUsageParams[] = [];
    const adapter = new AcpAdapter(
      {
        resolveWorkspaceId: () => 'ws_1',
        decideBlocked: () => ({ collisions: [], blocked: false }),
        recordUsage: (params) => { seen.push(params); },
      },
      process.execPath, [FAKE_AGENT],
    );
    const proc = adapter.spawn({ cwd: process.cwd(), env: { CW_SESSION_ID: 's_1' }, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write(`__USAGE_UPDATE__:${JSON.stringify({ used: 500, size: 200000 })}`);
    await waitFor(() => read().includes('USAGE_REPORTED'));
    expect(seen).toEqual([{ sessionId: 's_1', tokensUsed: 500, costUsd: undefined }]);
    proc.kill();
  });

  it('a usage_update with no CW_SESSION_ID in env: recordUsage is never called (best-effort, no session to attribute it to)', async () => {
    const adapter = new AcpAdapter(
      {
        resolveWorkspaceId: () => 'ws_1',
        decideBlocked: () => ({ collisions: [], blocked: false }),
        recordUsage: () => { throw new Error('must not be called with no session id'); },
      },
      process.execPath, [FAKE_AGENT],
    );
    const proc = adapter.spawn({ cwd: process.cwd(), env: {}, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write(`__USAGE_UPDATE__:${JSON.stringify({ used: 500, size: 200000 })}`);
    await waitFor(() => read().includes('USAGE_REPORTED'));
    proc.kill();
  });

  it('a usage_update where recordUsage throws does not crash the adapter or break subsequent onData', async () => {
    const adapter = new AcpAdapter(
      {
        resolveWorkspaceId: () => 'ws_1',
        decideBlocked: () => ({ collisions: [], blocked: false }),
        recordUsage: () => { throw new Error('simulated DB error'); },
      },
      process.execPath, [FAKE_AGENT],
    );
    const proc = adapter.spawn({ cwd: process.cwd(), env: { CW_SESSION_ID: 's_1' }, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write(`__USAGE_UPDATE__:${JSON.stringify({ used: 500, size: 200000 })}`);
    await waitFor(() => read().includes('USAGE_REPORTED'));
    proc.kill();
  });
```

- [ ] **Step 3: Run to verify the expected failures**

Run: `bun test tests/adapters/acp.test.ts`
Expected: FAIL — `Property 'recordUsage' is missing` (TS) plus the new tests timing out
or asserting against an empty `seen` array (the adapter doesn't call `recordUsage` yet).

- [ ] **Step 4: Implement it**

In `src/adapters/acp.ts`, find:

```ts
import type { DecideBlockedParams, DecideBlockedResult } from '../radar/decision.js';
import { CrossweaveError } from '../core/errors.js';

export interface AcpAdapterDeps {
  resolveWorkspaceId(sessionId: string): string;
  decideBlocked(params: DecideBlockedParams): DecideBlockedResult;
}
```

Replace with:

```ts
import type { DecideBlockedParams, DecideBlockedResult } from '../radar/decision.js';
import { CrossweaveError } from '../core/errors.js';
import type { RecordUsageParams } from '../domain/usage.js';

export interface AcpAdapterDeps {
  resolveWorkspaceId(sessionId: string): string;
  decideBlocked(params: DecideBlockedParams): DecideBlockedResult;
  recordUsage(params: RecordUsageParams): void;
}
```

Find `renderSessionUpdate` and add `reportUsageUpdate` right after it:

```ts
function renderSessionUpdate(update: SessionUpdate): string {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
    case 'user_message_chunk':
      return update.content.type === 'text' ? update.content.text : '';
    case 'tool_call':
      return `[cursor: ${update.kind ?? 'tool'} ${update.title}]\n`;
    case 'tool_call_update':
      return `[cursor: ${update.status ?? 'update'} ${update.toolCallId}]\n`;
    default:
      return '';
  }
}
```

Replace with:

```ts
function renderSessionUpdate(update: SessionUpdate): string {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
    case 'user_message_chunk':
      return update.content.type === 'text' ? update.content.text : '';
    case 'tool_call':
      return `[cursor: ${update.kind ?? 'tool'} ${update.title}]\n`;
    case 'tool_call_update':
      return `[cursor: ${update.status ?? 'update'} ${update.toolCallId}]\n`;
    default:
      return '';
  }
}

/**
 * M6a: ACP's usage_update is native to the protocol (design doc §2) — used/size are
 * context-window tokens, cost is optional and agent-dependent. Reported in-process,
 * no RPC, mirroring decideRequestPermission's own reasoning for calling decideBlocked
 * directly. Unlike decideRequestPermission, this is NOT a safety decision — a missing
 * session id or a recordUsage failure is a silent no-op, never surfaced to the agent,
 * because usage accounting is best-effort observability and must never break a turn.
 */
function reportUsageUpdate(update: SessionUpdate, sessionId: string | undefined, deps: AcpAdapterDeps): void {
  if (update.sessionUpdate !== 'usage_update' || sessionId === undefined) return;
  try {
    deps.recordUsage({ sessionId, tokensUsed: update.used, costUsd: update.cost?.amount });
  } catch {
    // Best-effort — see the doc comment above.
  }
}
```

Find the `sessionUpdate` handler inside `clientImpl`:

```ts
      sessionUpdate: async (params: SessionNotification): Promise<void> => {
        fanOut(this.dataListeners, renderSessionUpdate(params.update));
      },
```

Replace with:

```ts
      sessionUpdate: async (params: SessionNotification): Promise<void> => {
        reportUsageUpdate(params.update, opts.env.CW_SESSION_ID, deps);
        fanOut(this.dataListeners, renderSessionUpdate(params.update));
      },
```

- [ ] **Step 5: Wire `cursorDeps.recordUsage` in the daemon**

In `src/daemon/methods.ts`, find:

```ts
  const cursorDeps: AcpAdapterDeps = {
    resolveWorkspaceId: (sessionId) => {
      const row = sessionsRepo.findById(sessionId);
      if (!row) throw new CrossweaveError('SESSION_NOT_FOUND', `No such session: ${sessionId}`);
      return row.workspaceId;
    },
    decideBlocked: (params) => decideBlocked({ fileClaims, workspaces, sessions }, params),
  };
```

Replace with:

```ts
  const cursorDeps: AcpAdapterDeps = {
    resolveWorkspaceId: (sessionId) => {
      const row = sessionsRepo.findById(sessionId);
      if (!row) throw new CrossweaveError('SESSION_NOT_FOUND', `No such session: ${sessionId}`);
      return row.workspaceId;
    },
    decideBlocked: (params) => decideBlocked({ fileClaims, workspaces, sessions }, params),
    recordUsage: (params) => recordUsage({ sessions: sessionsRepo }, params),
  };
```

(`recordUsage` is already imported from `'../domain/usage.js'` by Task 3.)

- [ ] **Step 6: Fix the other two `AcpAdapterDeps` literals**

In `tests/adapters/registry.test.ts`, find:

```ts
  it('returns a cursor adapter with T1 when deps are provided', () => {
    const a = createAdapter('cursor', {
      resolveWorkspaceId: () => 'ws_1',
      decideBlocked: () => ({ collisions: [], blocked: false }),
    });
    expect(a.kind).toBe('cursor');
    expect(a.enforcementTier).toBe('T1');
  });
```

Replace with:

```ts
  it('returns a cursor adapter with T1 when deps are provided', () => {
    const a = createAdapter('cursor', {
      resolveWorkspaceId: () => 'ws_1',
      decideBlocked: () => ({ collisions: [], blocked: false }),
      recordUsage: () => {},
    });
    expect(a.kind).toBe('cursor');
    expect(a.enforcementTier).toBe('T1');
  });
```

In `tests/adapters/acp-integration.test.ts`, find:

```ts
import { decideBlocked } from '../../src/radar/decision.js';
import { AcpAdapter, type AcpAdapterDeps } from '../../src/adapters/acp.js';
import { CrossweaveError } from '../../src/core/errors.js';
```

Replace with:

```ts
import { decideBlocked } from '../../src/radar/decision.js';
import { recordUsage } from '../../src/domain/usage.js';
import { AcpAdapter, type AcpAdapterDeps } from '../../src/adapters/acp.js';
import { CrossweaveError } from '../../src/core/errors.js';
```

This file has two identical `cursorDeps` literals (one per `it`). Fix both — find (it
appears twice, verbatim):

```ts
    const cursorDeps: AcpAdapterDeps = {
      resolveWorkspaceId: (sessionId) => {
        const row = sessionsRepo.findById(sessionId);
        if (!row) throw new CrossweaveError('SESSION_NOT_FOUND', `No such session: ${sessionId}`);
        return row.workspaceId;
      },
      decideBlocked: (params) => decideBlocked({ fileClaims, workspaces, sessions }, params),
    };
```

Replace **both** occurrences with:

```ts
    const cursorDeps: AcpAdapterDeps = {
      resolveWorkspaceId: (sessionId) => {
        const row = sessionsRepo.findById(sessionId);
        if (!row) throw new CrossweaveError('SESSION_NOT_FOUND', `No such session: ${sessionId}`);
        return row.workspaceId;
      },
      decideBlocked: (params) => decideBlocked({ fileClaims, workspaces, sessions }, params),
      recordUsage: (params) => recordUsage({ sessions: sessionsRepo }, params),
    };
```

- [ ] **Step 7: Add a real-wiring integration test for `usage_update`**

Still in `tests/adapters/acp-integration.test.ts`, add this test at the end of
`describe('AcpAdapter composed with the real decideBlocked (not a stub)', ...)`, right
before the block's closing `});`:

```ts

  it('a usage_update notification, through the exact wiring buildMethods uses, writes to the real session row', async () => {
    const db = openDatabase(':memory:');
    new WorkspaceRepo(db).insert({
      id: 'ws_1', name: 'w', rootPath: process.cwd(), createdAt: 'now',
      defaultIsolation: 'worktree', safeModeTier: 'T1',
    });
    const sessionsRepo = new SessionRepo(db);
    sessionsRepo.insert({
      id: 's_1', workspaceId: 'ws_1', name: 's_1', agentKind: 'cursor', adapter: 'cursor',
      status: 'running', worktreePath: process.cwd(), branch: 'cw/s_1', createdAt: 'now',
      lastActiveAt: 'now', tokenBudget: null, tokenSpent: 0, costBudgetUsd: null,
      costSpentUsd: 0, enforcementTier: 'T1', pid: null,
    });

    const workspaces = new WorkspaceManager(db);
    const sessions = new SessionManager(db);
    const fileClaims = new FileClaimRepo(db);
    const cursorDeps: AcpAdapterDeps = {
      resolveWorkspaceId: (sessionId) => {
        const row = sessionsRepo.findById(sessionId);
        if (!row) throw new CrossweaveError('SESSION_NOT_FOUND', `No such session: ${sessionId}`);
        return row.workspaceId;
      },
      decideBlocked: (params) => decideBlocked({ fileClaims, workspaces, sessions }, params),
      recordUsage: (params) => recordUsage({ sessions: sessionsRepo }, params),
    };

    const adapter = new AcpAdapter(cursorDeps, process.execPath, [FAKE_AGENT]);
    const proc = adapter.spawn({ cwd: process.cwd(), env: { CW_SESSION_ID: 's_1' }, cols: 80, rows: 24 });
    const read = collect(proc);
    proc.write(`__USAGE_UPDATE__:${JSON.stringify({ used: 16700, size: 200000, cost: { amount: 0.0123, currency: 'USD' } })}`);
    await waitFor(() => read().includes('USAGE_REPORTED'));

    const row = sessionsRepo.findById('s_1')!;
    expect(row.tokenSpent).toBe(16700);
    expect(row.costSpentUsd).toBeCloseTo(0.0123);
    proc.kill();
  });
```

- [ ] **Step 8: Run all four affected test files to verify they pass**

Run: `bun test tests/adapters/acp.test.ts tests/adapters/acp-integration.test.ts tests/adapters/registry.test.ts tests/helpers`
Expected: all PASS. (`tests/helpers` has no `.test.ts` files of its own — this just
confirms the fixture file still type-checks; the real coverage is in the other three.)

- [ ] **Step 9: Full suite and typecheck**

Run: `bun run typecheck && bun test`
Expected: 0 typecheck errors; full suite green.

- [ ] **Step 10: Commit**

```bash
git add src/adapters/acp.ts src/daemon/methods.ts tests/adapters/acp.test.ts \
  tests/adapters/acp-integration.test.ts tests/adapters/registry.test.ts \
  tests/helpers/fake-acp-agent.ts
git commit -m "feat(adapters): AcpAdapter reports usage_update to recordUsage

In-process, no RPC — mirrors decideRequestPermission's own reasoning
for calling decideBlocked directly. Unlike the permission decision,
this is best-effort: a missing session id or a recordUsage failure
is a silent no-op, never surfaced to the agent."
```

---

### Task 6: CLI surface — `--budget-tokens`/`--budget-usd`, and a spend column on `session list`

**Files:**
- Modify: `src/domain/session.ts`
- Modify: `src/daemon/methods.ts`
- Modify: `src/cli/commands/session.ts`
- Modify: `tests/domain/session.test.ts`
- Create: `tests/cli/session.test.ts`
- Modify: `tests/cli/cli.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `CreateSessionOptions` gains `budgetTokens?: number; budgetUsd?: number`.
  `formatSpend(s: SpendFields): string` and `parseOptionalNumberArg(flag: string, raw:
  string | undefined): number | undefined`, both exported from
  `src/cli/commands/session.ts` for direct testing.

- [ ] **Step 1: Write the failing test for `SessionManager.create`'s budget threading**

In `tests/domain/session.test.ts`, find:

```ts
  it('shares the project root when worktree is false', async () => {
    const s = await sessions.create({ workspaceId, name: 'shared', agent: 'claude', worktree: false });
    expect(s.worktreePath).toBe(fx.root);
    expect(s.branch).toBeNull();
  });
```

Add these two tests right after it:

```ts

  it('threads budgetTokens/budgetUsd into the created row when provided', async () => {
    const s = await sessions.create({
      workspaceId, name: 'budgeted', agent: 'claude', worktree: true,
      budgetTokens: 100000, budgetUsd: 5,
    });
    expect(s.tokenBudget).toBe(100000);
    expect(s.costBudgetUsd).toBe(5);
  });

  it("leaves both budgets null when neither is provided (today's default, unchanged)", async () => {
    const s = await sessions.create({ workspaceId, name: 'unbudgeted', agent: 'claude', worktree: true });
    expect(s.tokenBudget).toBeNull();
    expect(s.costBudgetUsd).toBeNull();
  });
```

- [ ] **Step 2: Run to verify the expected failure**

Run: `bun test tests/domain/session.test.ts`
Expected: FAIL — TS error, `Object literal may only specify known properties, and
'budgetTokens' does not exist in type 'CreateSessionOptions'`.

- [ ] **Step 3: Thread the budget options through `SessionManager.create`**

In `src/domain/session.ts`, find:

```ts
export interface CreateSessionOptions {
  workspaceId: string;
  name: string;
  agent: string;
  worktree: boolean;
}
```

Replace with:

```ts
export interface CreateSessionOptions {
  workspaceId: string;
  name: string;
  agent: string;
  worktree: boolean;
  budgetTokens?: number;
  budgetUsd?: number;
}
```

Find (this is the post-Task-1-sweep state — `costSpentUsd: 0, costBudgetUsd: null,` is
what Task 1's mechanical sed left on this exact line):

```ts
      tokenBudget: null,
      tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: null,
      enforcementTier: adapter.enforcementTier,
```

Replace with:

```ts
      tokenBudget: opts.budgetTokens ?? null,
      tokenSpent: 0, costSpentUsd: 0, costBudgetUsd: opts.budgetUsd ?? null,
      enforcementTier: adapter.enforcementTier,
```

(If Task 1's sed produced different exact spacing on your branch, find the equivalent
`tokenBudget: null,` / `tokenSpent: 0` pair inside `SessionManager.create`'s row
literal and apply the same two substitutions — `null` → `opts.budgetTokens ?? null` for
`tokenBudget`, and the sed-inserted `costBudgetUsd: null` → `costBudgetUsd: opts.budgetUsd ?? null`.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/domain/session.test.ts`
Expected: all PASS.

- [ ] **Step 5: Thread the params through the `session.new` RPC**

In `src/daemon/methods.ts`, find:

```ts
    'session.new': (p) =>
      sessions.create({
        workspaceId: str(p, 'workspaceId'),
        name: str(p, 'name'),
        agent: str(p, 'agent'),
        worktree: bool(p, 'worktree', true),
      }),
```

Replace with:

```ts
    'session.new': (p) =>
      sessions.create({
        workspaceId: str(p, 'workspaceId'),
        name: str(p, 'name'),
        agent: str(p, 'agent'),
        worktree: bool(p, 'worktree', true),
        budgetTokens: optionalNum(p, 'budgetTokens'),
        budgetUsd: optionalNum(p, 'budgetUsd'),
      }),
```

(`optionalNum` already exists — added in Task 3.)

- [ ] **Step 6: Write the failing tests for the CLI-side pure functions**

Create `tests/cli/session.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { formatSpend, parseOptionalNumberArg } from '../../src/cli/commands/session.js';

describe('parseOptionalNumberArg', () => {
  test('undefined input returns undefined', () => {
    expect(parseOptionalNumberArg('--budget-usd', undefined)).toBeUndefined();
  });

  test('a valid numeric string parses to a number', () => {
    expect(parseOptionalNumberArg('--budget-usd', '5.5')).toBe(5.5);
  });

  test('a non-numeric string throws INVALID_ARGUMENTS naming the flag', () => {
    expect(() => parseOptionalNumberArg('--budget-usd', 'nope')).toThrowError(
      expect.objectContaining({ code: 'INVALID_ARGUMENTS' }) as unknown as Error,
    );
  });
});

describe('formatSpend', () => {
  const base = { tokenSpent: 0, tokenBudget: null, costSpentUsd: 0, costBudgetUsd: null };

  test('a fresh session with no budgets shows zero spend, no marker', () => {
    expect(formatSpend(base)).toBe('$0.0000/0.0k');
  });

  test('spend under budget shows no marker', () => {
    expect(formatSpend({ ...base, costSpentUsd: 1, costBudgetUsd: 5 })).toBe('$1.0000/0.0k');
  });

  test('cost spend over its budget appends the OVER BUDGET marker', () => {
    expect(formatSpend({ ...base, costSpentUsd: 6, costBudgetUsd: 5 })).toBe('$6.0000/0.0k OVER BUDGET');
  });

  test('token spend over its budget appends the OVER BUDGET marker', () => {
    expect(formatSpend({ ...base, tokenSpent: 2000, tokenBudget: 1000 })).toBe('$0.0000/2.0k OVER BUDGET');
  });

  test('spend exactly at budget is not over', () => {
    expect(formatSpend({ ...base, costSpentUsd: 5, costBudgetUsd: 5 })).toBe('$5.0000/0.0k');
  });
});
```

- [ ] **Step 7: Run to verify the expected failure**

Run: `bun test tests/cli/session.test.ts`
Expected: FAIL — `Cannot find module` (`formatSpend`/`parseOptionalNumberArg` don't
exist yet), and `bun run typecheck` also fails on the same missing exports.

- [ ] **Step 8: Implement the CLI changes**

In `src/cli/commands/session.ts`, find:

```ts
import { defineCommand } from 'citty';
import { CrossweaveError } from '../../core/errors.js';
import { withClient, fail, currentWorkspaceId } from '../context.js';
import { attachCommand } from './attach.js';

interface Session {
  id: string; name: string; status: string; agentKind: string;
  enforcementTier: string; worktreePath: string | null; branch: string | null;
}
```

Replace with:

```ts
import { defineCommand } from 'citty';
import { CrossweaveError } from '../../core/errors.js';
import { withClient, fail, currentWorkspaceId } from '../context.js';
import { attachCommand } from './attach.js';

interface Session {
  id: string; name: string; status: string; agentKind: string;
  enforcementTier: string; worktreePath: string | null; branch: string | null;
  tokenSpent: number; tokenBudget: number | null;
  costSpentUsd: number; costBudgetUsd: number | null;
}

/** The subset of Session's fields formatSpend needs — kept separate so the CLI unit
 * tests (tests/cli/session.test.ts) can pass a plain object without every field. */
interface SpendFields {
  tokenSpent: number; tokenBudget: number | null;
  costSpentUsd: number; costBudgetUsd: number | null;
}

/** Exported for direct testing. citty has no numeric arg type (only string, boolean,
 * positional, enum) — flags declared `type: 'string'` are parsed here instead. */
export function parseOptionalNumberArg(flag: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new CrossweaveError('INVALID_ARGUMENTS', `${flag} must be a number, got: ${raw}`);
  }
  return n;
}

/**
 * Always shows current spend (design doc §1: "cw session list showing real, live
 * spend" is M6a's own success criterion, independent of whether a budget is set) and
 * appends a plain-text "OVER BUDGET" marker — no color/TTY-detection logic, matching
 * this CLI's tab-separated, script-parseable output convention — when spend exceeds a
 * budget that IS set. Exported for direct testing.
 */
export function formatSpend(s: SpendFields): string {
  const costPart = `$${s.costSpentUsd.toFixed(4)}`;
  const tokenPart = `${(s.tokenSpent / 1000).toFixed(1)}k`;
  const overCost = s.costBudgetUsd !== null && s.costSpentUsd > s.costBudgetUsd;
  const overTokens = s.tokenBudget !== null && s.tokenSpent > s.tokenBudget;
  const marker = overCost || overTokens ? ' OVER BUDGET' : '';
  return `${costPart}/${tokenPart}${marker}`;
}
```

Find the `new` subcommand:

```ts
    new: defineCommand({
      meta: { name: 'new', description: 'Create a session' },
      // citty derives `--no-worktree` automatically from a boolean named `worktree`,
      // so declaring a literal `no-worktree` flag would collide with that negation.
      args: {
        name: { type: 'string', required: true, description: 'Session name' },
        agent: { type: 'string', default: 'claude', description: 'Agent kind' },
        worktree: { type: 'boolean', default: true, description: 'Isolate in a git worktree' },
      },
      async run({ args }) {
        try {
          await withClient(async (client) => {
            const workspaceId = await currentWorkspaceId(client);
            const worktree = args.worktree;
            if (!worktree) {
              process.stderr.write(
                'warning: --no-worktree shares the project root. ' +
                  'Sessions can overwrite each other\'s files.\n',
              );
            }
            const s = await client.call<Session>('session.new', {
              workspaceId, name: args.name, agent: args.agent, worktree,
            });
            process.stdout.write(
              `${s.name}\t${s.status}\t${s.enforcementTier}\t${s.worktreePath ?? '-'}\n`,
            );
          });
        } catch (err) { fail(err); }
      },
    }),
```

Replace with:

```ts
    new: defineCommand({
      meta: { name: 'new', description: 'Create a session' },
      // citty derives `--no-worktree` automatically from a boolean named `worktree`,
      // so declaring a literal `no-worktree` flag would collide with that negation.
      args: {
        name: { type: 'string', required: true, description: 'Session name' },
        agent: { type: 'string', default: 'claude', description: 'Agent kind' },
        worktree: { type: 'boolean', default: true, description: 'Isolate in a git worktree' },
        'budget-tokens': { type: 'string', description: 'Warn once cumulative tokens spent exceeds this' },
        'budget-usd': { type: 'string', description: 'Warn once cumulative cost (USD) exceeds this' },
      },
      async run({ args }) {
        try {
          const budgetTokens = parseOptionalNumberArg('--budget-tokens', args['budget-tokens']);
          const budgetUsd = parseOptionalNumberArg('--budget-usd', args['budget-usd']);
          await withClient(async (client) => {
            const workspaceId = await currentWorkspaceId(client);
            const worktree = args.worktree;
            if (!worktree) {
              process.stderr.write(
                'warning: --no-worktree shares the project root. ' +
                  'Sessions can overwrite each other\'s files.\n',
              );
            }
            const s = await client.call<Session>('session.new', {
              workspaceId, name: args.name, agent: args.agent, worktree, budgetTokens, budgetUsd,
            });
            process.stdout.write(
              `${s.name}\t${s.status}\t${s.enforcementTier}\t${s.worktreePath ?? '-'}\n`,
            );
          });
        } catch (err) { fail(err); }
      },
    }),
```

Find the `list` subcommand:

```ts
    list: defineCommand({
      meta: { name: 'list', description: 'List sessions' },
      async run() {
        try {
          await withClient(async (client) => {
            const workspaceId = await currentWorkspaceId(client);
            const rows = await client.call<Session[]>('session.list', { workspaceId });
            if (rows.length === 0) { process.stdout.write('no sessions\n'); return; }
            process.stdout.write('NAME\tSTATUS\tAGENT\tTIER\tBRANCH\n');
            for (const s of rows) {
              process.stdout.write(
                `${s.name}\t${s.status}\t${s.agentKind}\t${s.enforcementTier}\t${s.branch ?? '-'}\n`,
              );
            }
          });
        } catch (err) { fail(err); }
      },
    }),
```

Replace with:

```ts
    list: defineCommand({
      meta: { name: 'list', description: 'List sessions' },
      async run() {
        try {
          await withClient(async (client) => {
            const workspaceId = await currentWorkspaceId(client);
            const rows = await client.call<Session[]>('session.list', { workspaceId });
            if (rows.length === 0) { process.stdout.write('no sessions\n'); return; }
            process.stdout.write('NAME\tSTATUS\tAGENT\tTIER\tBRANCH\tSPEND\n');
            for (const s of rows) {
              process.stdout.write(
                `${s.name}\t${s.status}\t${s.agentKind}\t${s.enforcementTier}\t${s.branch ?? '-'}\t${formatSpend(s)}\n`,
              );
            }
          });
        } catch (err) { fail(err); }
      },
    }),
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `bun test tests/cli/session.test.ts`
Expected: all PASS.

- [ ] **Step 10: Write the e2e round-trip tests**

In `tests/cli/cli.test.ts`, find:

```ts
  it('workspace safe-mode shows and sets the tier, including T1', async () => {
```

Add these two tests right before it:

```ts
  it('session new accepts --budget-tokens/--budget-usd, and list shows live spend', async () => {
    await cw(['init']);
    const created = await cw([
      'session', 'new', '--name', 'budgeted', '--agent', 'claude',
      '--budget-tokens', '1000', '--budget-usd', '5',
    ]);
    expect(created.exitCode).toBe(0);

    const listed = await cw(['session', 'list']);
    expect(listed.stdout).toContain('SPEND');
    expect(listed.stdout).toContain('budgeted');
    // A freshly created session has spent nothing yet, and nothing exceeds a budget.
    expect(listed.stdout).toContain('$0.0000/0.0k');
    expect(listed.stdout).not.toContain('OVER BUDGET');
  }, 60_000);

  it('rejects a non-numeric --budget-usd on exactly one stderr line', async () => {
    await cw(['init']);
    const r = await cw(['session', 'new', '--name', 'bad-budget', '--agent', 'claude', '--budget-usd', 'not-a-number']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('INVALID_ARGUMENTS:');
    const lines = r.stderr.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
  }, 30_000);

```

- [ ] **Step 11: Run to verify they pass**

Run: `bun test tests/cli/cli.test.ts`
Expected: all PASS.

- [ ] **Step 12: Full suite and typecheck**

Run: `bun run typecheck && bun test`
Expected: 0 typecheck errors; full suite green.

- [ ] **Step 13: Commit**

```bash
git add src/domain/session.ts src/daemon/methods.ts src/cli/commands/session.ts \
  tests/domain/session.test.ts tests/cli/session.test.ts tests/cli/cli.test.ts
git commit -m "feat(cli): --budget-tokens/--budget-usd on session new, spend column on session list

cw session list now shows real, live spend (M6a's own success
criterion, design doc §1) plus a plain-text OVER BUDGET marker when
a set budget is exceeded — no color/TTY-detection logic, matching
this project's tab-separated, script-parseable CLI output."
```

---

### Task 7: M6a known-limitations doc, full verification, wrap-up

**Files:**
- Create: `docs/superpowers/specs/2026-08-13-m6a-known-limitations.md`

**Interfaces:** none.

- [ ] **Step 1: Write the known-limitations doc**

Create `docs/superpowers/specs/2026-08-13-m6a-known-limitations.md`:

```markdown
# crossweave M6a — known limitations

Accepted gaps carried out of M6a (budget/burn backend), found and deliberately
deferred during implementation — see
`docs/superpowers/specs/2026-08-13-m6a-budget-burn-design.md` for the full design this
summarizes.

## Not authoritative billing data

Both usage sources — Claude Code's `statusLine` payload and ACP's `usage_update` — are
Anthropic's own client-side estimates. Anthropic's docs state this explicitly for both:
"client-side estimates... do not bill end users or trigger financial decisions from
these fields." crossweave inherits that imprecision. `cw session list`'s spend column
and any future UI built on `costSpentUsd`/`tokenSpent` must never imply otherwise.

## Claude Code's statusLine cadence is "after every assistant message," not real-time

Claude Code debounces statusLine updates at 300ms and only re-invokes the command on
specific triggers (a new assistant message, `/compact` finishing, a permission-mode
change, a `refreshInterval` timer if configured) — not continuously. A long single turn
(a big tool call, an extended thinking block) shows stale spend until the turn's
message lands. Acceptable for a budget meter, not for anything time-critical.

## ACP's `cost` field is optional and agent-dependent

`UsageUpdate.cost` is optional in the ACP schema — an agent that never populates it
means `costSpentUsd` simply never updates for that session over the ACP (T1) path;
`tokenSpent` (from `used`) is more reliably present, since it is a required field of
the schema. Whether a given ACP agent populates `cost` is entirely outside
crossweave's control and could change with no code change on crossweave's side either
way (same "implementation-quality, not structural" caveat M5b's known-limitations doc
already documents for `AcpAdapter`'s `locations` dependency).

## No auto-pause, no OpenTUI, no per-turn granularity

All three were explicitly out of scope for M6a (design doc §1 non-goals) and remain so:

- A budget set via `--budget-tokens`/`--budget-usd` is informational only. `cw session
  list` shows the `OVER BUDGET` marker; nothing pauses or interrupts the session. The
  design spec's "paused, not killed, and the user is prompted" needs a UI to prompt
  through — that is M6c's job, once there is a TUI to prompt in.
- No live-updating display of any kind. `cw session list` is a one-shot CLI query;
  seeing updated spend means running it again.
- Both usage sources report cumulative session-level totals only. A per-turn breakdown
  is not available from either without materially more invasive integration (parsing
  Claude Code's undocumented transcript JSONL, or waiting on ACP's still-draft End-Turn
  Token Usage RFD) and was not required for a budget meter, which only needs "how much
  so far."

## `session.reportUsage` resolves no workspace, and silently no-ops on an unknown session id

Deliberate, not an oversight: this is a high-frequency, best-effort call (Claude
Code's statusLine fires after every assistant message), and both callers (the
statusLine hook, `AcpAdapter` in-process) already know the exact session id from
`CW_SESSION_ID`/ACP's own permission-boundary wiring. Resolving a workspace or
validating the session exists would add work with no purpose on this path, and
`SessionRepo.updateUsage`'s plain `UPDATE ... WHERE id = ?` already degrades an unknown
id to "0 rows affected" rather than throwing — matching the "never block the agent"
posture this project's other hooks/best-effort paths already have.
```

- [ ] **Step 2: Full local gate**

```bash
bun run typecheck
bun test
```

Expected: `tsc --noEmit` reports 0 errors; `bun test` reports 0 fail. If you see a
`pgrep`/stray-daemon-process-related failure in `tests/packaging/binary.test.ts`
specifically, that is a known environment artifact from leftover processes across a
session's test runs (documented precedent in M5b's own plan), not something this
plan's changes cause — run `pgrep -fl dist/cwd`, `kill -9` any stray PIDs found, and
re-run the suite once to confirm.

- [ ] **Step 3: Confirm the mechanical sweep (Task 1, Step 6) left no stragglers**

```bash
grep -rn "tokenSpent: 0,$" tests/ src/ 2>/dev/null
```

Expected: no output (every occurrence should now have `costSpentUsd`/`costBudgetUsd`
on the same line, not a bare trailing comma at end-of-line — the sed in Task 1
inserted text right after `tokenSpent: 0,`, so a bare `tokenSpent: 0,` at end of line
with nothing after it would mean that file was missed). If anything matches, apply
Task 1 Step 6's fix to it directly and re-run the full gate (Step 2 above).

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-08-13-m6a-known-limitations.md
git commit -m "docs: record M6a's known limitations"
```

- [ ] **Step 5: Final report**

No further commits in this step. Report to the user: files changed, test count,
confirmation that `bun run typecheck` and `bun test` are both clean, and that the
branch is ready for review (not merged — merging requires the user's explicit
go-ahead per this project's standing rule).

---

## Deferred (explicitly out of scope, per the approved spec §7)

- OpenTUI dashboard rendering of any of this (M6c).
- Auto-pause on overrun, interactive user prompting (M6c).
- Per-turn usage granularity.
- Live push notification of usage changes (M6b's push-notification infrastructure
  could carry this later; M6a's own consumer, `cw session list`, is a one-shot pull, so
  it isn't needed here).
