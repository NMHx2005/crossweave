# Land & Lease Reliability Implementation Plan

> **Status after review (2026-09-17): shipped.** Every task is on `main`; the
> steps below are left unticked on purpose, because they are the TDD sequence as
> written, not a tracker (the repo's older plans follow the same convention —
> see `2026-09-16-cockpit-electron.md` for the one plan whose steps are ticked).
> Task → commit: 1 `01c1362`, 2 `0f2bad4`, 3 `bf94590` + `7b6bc12`, 4 `f99f678`,
> 5 `5d8e7b5`; the follow-ups this work needed are `92e7441` (lease summary in
> `session list`), `37ef613` (persisted trial kind, re-trial after the base moves)
> and `48b20b2` (the post-land unknown window, documented).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `cw land` / `cw land all` evidence-gated and non-spurious, and make port/cache/db leases honest, non-leaking, and visible — so a solo daily driver can trust fan-in and runtime isolation without a Deck-like UI.

**Architecture:** Keep the daemon as sole state owner. Add a pure `classifyLandability` helper consumed by `converge.status` and the CLI/TUI land-all loops. Persist `base_head` on every `merge_trial` so “fresh” means “trialled against current base HEAD.” Close M1 dispose/disk/`PORT` gaps in isolation and session teardown. No desktop, no multi-pane, no new runtime dependencies.

**Tech Stack:** Bun ≥1.3.13, TypeScript, `bun:sqlite`, `bun test`, existing `citty` / `simple-git` — no new packages.

**Spec:** `docs/superpowers/specs/2026-09-15-land-lease-reliability-design.md`

## Global Constraints

- No new runtime dependencies (stay on the current `package.json` set).
- `SCHEMA_VERSION` bumps from 9 → 10 with a forward-only migration list entry in `src/db/schema.ts`.
- New/changed RPCs use existing `str` / `bool` helpers and throw `CrossweaveError` with `UPPER_SNAKE_CASE` codes.
- Leases remain cooperative env injection — do not claim sandboxing; document limits in known-limitations.
- Multi-pane / thin desktop / M9 VT work is out of scope.
- Safe Mode / Bash interception is out of scope.
- User-facing CLI copy stays English; comments English.
- Prefer extracting pure functions + tests before wiring daemon/CLI (existing repo pattern).
- Commit after each task.

## File map

| File | Responsibility |
|---|---|
| `src/convergence/evidence.ts` | Pure landability classification (`ready` / `unknown` / `blocked`) |
| `src/convergence/land.ts` | Squash no-op after `--squash`; rebase error text concatenates stdout+stderr |
| `src/db/schema.ts` + `merge-trial.ts` | Add `base_head` column; repo read/write |
| `src/daemon/convergence-scheduler.ts` | Record `baseHead` on every trial; capture base **inside** the integration lock |
| `src/daemon/methods.ts` | `converge.status` returns evidence fields; enrich session list leases |
| `src/cli/commands/land.ts` | Re-fetch status between lands; single error line; respect `ready` |
| `src/cli/commands/tui.ts` | `landAllInOrder` re-fetches ready names between lands |
| `src/cli/commands/converge.ts` | Print degraded / unknown / unverified clearly |
| `src/cli/commands/session.ts` | Lease summary on `session list` |
| `src/core/config.ts` | Reserve `PORT` in `RESERVED_ENV_NAMES` |
| `src/isolation/leases/ports.ts` | Probe every port in the candidate block |
| `src/domain/gc.ts` | Export shared `disposeLeasedPaths` |
| `src/domain/session.ts` | Call dispose on `remove` and `kill({ removeWorktree: true })` before row delete |
| `src/isolation/disk-guard.ts` | Count cache + file-copy db bytes per session |
| `docs/superpowers/specs/2026-08-14-known-limitations-digest.md` | Refresh stale lines; note cooperative leases |

---

### Task 1: Squash no-op + rebase conflict message

**Files:**
- Modify: `src/convergence/land.ts`
- Test: `tests/convergence/land.test.ts`

**Interfaces:**
- Consumes: existing `landSession`, `runGit`, `commitsAhead`, `recoverMainCheckoutAndFail`
- Produces: squash path that treats empty index after `--squash` as success; exported `gitFailureText(cause)` used for rebase/merge failures (stdout + stderr)

- [ ] **Step 1: Write the failing tests**

Append to `tests/convergence/land.test.ts`:

```ts
test('squash no-op when commits exist but net diff vs base is empty', async () => {
  const fixture = await makeGitFixture();
  try {
    await commitFile(fixture.root, 'x.txt', 'same\n', 'base x');
    await $`git checkout -q -b cw/a`.cwd(fixture.root).quiet();
    await commitFile(fixture.root, 'x.txt', 'temp\n', 'temp change');
    await commitFile(fixture.root, 'x.txt', 'same\n', 'revert to base content');
    await $`git checkout -q main`.cwd(fixture.root).quiet();

    const { db, sessions, leaseManager, ledger, config, configTrust } = await setup(
      fixture,
      withStrategy('squash'),
    );
    insertSession(sessions, {
      id: 's_a', name: 'a', worktreePath: fixture.root, branch: 'cw/a', status: 'idle',
    });

    const result = await landSession(
      { db, projectRoot: fixture.root, sessions, leaseManager, ledger, config, configTrust },
      'ws_1', 's_a', { force: false },
    );
    expect(result.status).toBe('landed');
  } finally {
    await fixture.cleanup();
  }
});
```

Also test the helper:

```ts
import { gitFailureText } from '../../src/convergence/land.js';

test('gitFailureText concatenates stderr and stdout', () => {
  const err = Object.assign(new Error('Command failed'), {
    stderr: Buffer.from('CONFLICT (content): Merge conflict in a.ts\n'),
    stdout: Buffer.from('Rebasing (1/1)\n'),
  });
  const text = gitFailureText(err);
  expect(text).toContain('CONFLICT');
  expect(text).toContain('Rebasing');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/convergence/land.test.ts`
Expected: FAIL — squash path still `LAND_MERGE_FAILED`; `gitFailureText` not exported / prefers only stderr.

- [ ] **Step 3: Write minimal implementation**

In `src/convergence/land.ts`:

1. Replace `gitStderr` with exported `gitFailureText` that joins non-empty stderr and stdout (trim; fallback to `message`).
2. Point `recoverMainCheckoutAndFail` and rebase conflict throws at `gitFailureText`.
3. After `runGit(['merge', '--squash', branch], deps.projectRoot)`, detect empty index:

```ts
let hasStaged = true;
try {
  execFileSync('git', ['diff', '--cached', '--quiet'], { cwd: deps.projectRoot, stdio: 'ignore' });
  hasStaged = false; // exit 0 ⇒ no staged diff
} catch {
  hasStaged = true; // exit 1 ⇒ staged changes
}
if (hasStaged) {
  runGit(['commit', '-m', `${row.name}: squashed from ${branch}`], deps.projectRoot);
}
// else: net-zero squash — treat as successful no-op land (continue cleanup / mark landed)
```

Keep conflict failures on `merge --squash` going through `recoverMainCheckoutAndFail`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/convergence/land.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/convergence/land.ts tests/convergence/land.test.ts
git commit -m "$(cat <<'EOF'
fix(land): treat empty squash as success and surface full git failure text

Net-zero squash used to abort land all mid-batch; rebase/merge errors now keep stdout and stderr.
EOF
)"
```

---

### Task 2: `base_head` on merge trials + pure evidence classifier

**Files:**
- Modify: `src/db/schema.ts` (`SCHEMA_VERSION` 9 → 10)
- Modify: `src/db/repositories/merge-trial.ts`
- Create: `src/convergence/evidence.ts`
- Modify: `src/daemon/convergence-scheduler.ts`
- Test: `tests/db/merge-trial-repo.test.ts`
- Test: `tests/convergence/evidence.test.ts`

**Interfaces:**
- Produces:

```ts
// merge-trial.ts — MergeTrialRow gains:
baseHead: string;

// evidence.ts
export type Landability = 'ready' | 'unknown' | 'blocked';

export interface SessionEvidenceInput {
  name: string;
  branch: string;
}

export interface ClassifyInput {
  sessions: SessionEvidenceInput[];
  trials: MergeTrialRow[];
  currentBaseHead: string;
  degraded: boolean;
  hasTrustedTestCommand: boolean;
  latestFullIntegration: MergeTrialRow | null;
}

export interface SessionLandability {
  name: string;
  landability: Landability;
  reason: string;
}

export function classifyLandability(input: ClassifyInput): {
  byName: Map<string, SessionLandability>;
  ready: string[];
};
```

Rules (spec §2.1):

- `blocked` if the latest pairwise trial for this session’s branch vs any other active branch has `result` of `conflict` or `test_fail` (same “latest per sorted pair” selection as `buildConflictGraph`).
- `unknown` if `degraded`, or a required pairwise trial is missing, or that trial’s `baseHead !== currentBaseHead`, or `hasTrustedTestCommand` and latest full-integration is missing / `baseHead` stale / not `clean`.
- `ready` otherwise (pairwise fresh and clean vs all other active branches; full-integration required only when trusted testCommand).

- [ ] **Step 1: Write failing migration + tests**

```ts
// schema.ts
export const SCHEMA_VERSION = 10;
// append:
[
  `ALTER TABLE merge_trial ADD COLUMN base_head TEXT NOT NULL DEFAULT ''`,
],
```

Update `MergeTrialRepo` COLS / `toRow` / `insert` for `base_head` → `baseHead`.

Write `tests/convergence/evidence.test.ts` covering: ready with fresh clean pairwise; unknown when `baseHead` mismatches; unknown when degraded; blocked on conflict; ready without testCommand when pairwise ok; unknown when trusted testCommand but full-integration unverified/stale.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/convergence/evidence.test.ts tests/db/merge-trial-repo.test.ts`
Expected: FAIL (module / column / field missing)

- [ ] **Step 3: Write minimal implementation**

Implement `src/convergence/evidence.ts` per rules.

In `convergence-scheduler.ts`, extend `recordTrial` to require `baseHead: string`. Move `const base = baseHead(projectRoot)` to **inside** each `withIntegrationWorktreeLock` callback immediately before trials. Pass that SHA into every `recordTrial`.

Update every test helper that builds `MergeTrialRow` to include `baseHead`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/convergence/evidence.test.ts tests/db/merge-trial-repo.test.ts tests/daemon/convergence-scheduler.test.ts tests/convergence/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/db/repositories/merge-trial.ts src/convergence/evidence.ts \
  src/daemon/convergence-scheduler.ts tests/convergence/evidence.test.ts tests/db/merge-trial-repo.test.ts
# also add any test files updated for MergeTrialRow.baseHead
git commit -m "$(cat <<'EOF'
feat(converge): persist trial base_head and classify landability evidence

Status can distinguish ready vs unknown vs blocked instead of treating an empty graph as safe.
EOF
)"
```

---

### Task 3: Wire `converge.status` + evidence-gated `land all` (CLI + TUI)

**Files:**
- Modify: `src/daemon/methods.ts` (`converge.status`)
- Modify: `src/cli/commands/land.ts`
- Modify: `src/cli/commands/converge.ts`
- Modify: `src/cli/commands/tui.ts` (`landAllInOrder`)
- Test: `tests/daemon/methods-converge.test.ts`
- Test: `tests/cli/land.test.ts`
- Test: `tests/cli/tui-actions.test.ts`

**Interfaces:**

`converge.status` return shape:

```ts
{
  pairwise: { a: string; b: string; result: string }[];
  fullIntegration: {
    result: string; ts: string; detail: string | null; baseHead: string;
  } | null;
  recommendedOrder: string[];
  /** Back-compat: identical to `ready` after this change */
  conflictFree: string[];
  ready: string[];
  unknown: { name: string; reason: string }[];
  blocked: { name: string; reason: string }[];
  degraded: boolean;
}
```

`landAllInOrder` signature:

```ts
export async function landAllInOrder(
  fetchReady: () => Promise<string[]>,
  land: (name: string) => Promise<void>,
): Promise<{ landed: string[]; failedAt: string | undefined }>
```

Algorithm: loop — `const names = await fetchReady()`; if empty, return; land `names[0]`; on success append to `landed` and continue; on failure return `{ landed, failedAt: names[0] }`. Never walk a single snapshot.

CLI `land all`:

- Without `--force`: only land `status.ready`. If `ready` empty, print `nothing to land` (and if `unknown.length > 0`, print the first unknown reason on stderr).
- With `--force`: land `ready` first via re-fetch; then allow `unknown` with `warning: landing <name> with incomplete evidence: <reason>`; never auto-land `blocked`.
- On failure: **one** error line. Pattern:

```ts
} catch (err) {
  process.stdout.write(`stopped at ${name}: ${(err as Error).message}\n`);
  process.exitCode = 1;
  return; // do not rethrow into fail() — avoids double print
}
```

Keep `printLandResult` showing `tested: unverified` vs `clean`.

- [ ] **Step 1: Write the failing tests**

- Daemon: no trials → all active sessions `unknown`, `ready` empty.
- Daemon: fresh clean pairwise → `ready` contains that session.
- CLI/TUI: `landAllInOrder` with mock `fetchReady` returning `['a','b']` then `['b']` then `[]` after successive lands — assert both landed and fetch called ≥3 times.
- Update existing `landAllInOrder` callers/tests for the new signature.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/daemon/methods-converge.test.ts tests/cli/land.test.ts tests/cli/tui-actions.test.ts`

- [ ] **Step 3: Write minimal implementation**

In `converge.status`, resolve `currentBaseHead`, `hasTrustedTestCommand` (`ConfigTrustRepo` + `hashTestCommand`), call `classifyLandability`, fill `ready` / `unknown` / `blocked`, set `conflictFree = ready`.

Wire CLI + TUI + converge status printer for degraded/unknown.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/daemon/methods-converge.test.ts tests/cli/land.test.ts tests/cli/tui-actions.test.ts tests/convergence/`

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(land): evidence-gate land all and re-fetch status after each land

Empty or stale conflict graphs no longer look fully landable; base moves are rechecked between lands.
EOF
)"
```

---

### Task 4: Port honesty — reserve `PORT`, probe full block

**Files:**
- Modify: `src/core/config.ts`
- Modify: `src/isolation/leases/ports.ts`
- Test: `tests/core/config.test.ts`
- Test: `tests/isolation/ports.test.ts`

**Interfaces:**
- `RESERVED_ENV_NAMES` includes `'PORT'`
- `allocatePortBlock` requires every port in `candidate .. candidate+blockSize-1` free

- [ ] **Step 1: Write the failing tests**

```ts
// tests/core/config.test.ts
it('rejects a named entry that would override PORT', async () => {
  await writeFile(
    join(dir, 'crossweave.config.json'),
    JSON.stringify({ ports: { named: { PORT: 0 } } }),
  );
  expect(() => loadConfig(dir)).toThrowError(
    expect.objectContaining({ code: 'CONFIG_INVALID' }) as unknown as Error,
  );
});
```

```ts
// tests/isolation/ports.test.ts
test('skips a block when a non-base port in the block is occupied', async () => {
  // Listen on base+1; expect allocatePortBlock to return base+blockSize (next free block).
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/config.test.ts tests/isolation/ports.test.ts`

- [ ] **Step 3: Write minimal implementation**

Add `'PORT'` to `RESERVED_ENV_NAMES`.

In `allocatePortBlock`, after confirming the base is not leased and `isPortFree(candidate)`, loop offsets `1..blockSize-1` (and 0) with `isPortFree`; if any busy, continue to next candidate. Keep the post-await lease table re-read race fix. Update the file’s doc comment that currently says only the first port is probed.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/core/config.test.ts tests/isolation/ports.test.ts tests/isolation/lease-manager.test.ts`

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
fix(isolation): reserve PORT and probe the full port block before lease

Stops named overrides of PORT and EADDRINUSE from occupied offsets inside a block.
EOF
)"
```

---

### Task 5: Dispose leased paths on session rm/kill + disk accounting

**Files:**
- Modify: `src/domain/gc.ts` (export `disposeLeasedPaths`)
- Modify: `src/domain/session.ts` (`remove`, `kill` when disposing)
- Modify: `src/isolation/disk-guard.ts` (`measureWorktrees`)
- Test: `tests/domain/session.test.ts` (add or extend)
- Test: `tests/isolation/disk-guard.test.ts`
- Test: `tests/domain/gc.test.ts` (regression)

**Interfaces:**
- `export function disposeLeasedPaths(leases: LeaseRepo, workspace: WorkspaceRow, sessionId: string): void`
- `measureWorktrees` adds sizes for absolute `cache` / `db` lease paths under `.crossweave/`

- [ ] **Step 1: Write the failing tests**

- Session with a real cache directory lease → `remove` / `kill({ removeWorktree: true })` deletes that directory before the row is gone.
- `measureWorktrees`: empty worktree + large file under `.crossweave/cache/<id>` ⇒ session `bytes` includes that file.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/domain/session.test.ts tests/isolation/disk-guard.test.ts`

- [ ] **Step 3: Write minimal implementation**

Export `disposeLeasedPaths` from `gc.ts` (or move to `src/isolation/lease-dispose.ts` and import from both). Call it in `SessionManager.remove` and in `kill` **before** `sessions.delete`, whenever the session is being torn down with worktree removal (and on `remove` always).

Extend `measureWorktrees` to load leases per session and add `directorySize` / file size for absolute paths contained under `crossweaveDir(workspace.rootPath)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/domain/ tests/isolation/disk-guard.test.ts`

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
fix(isolation): dispose cache/db on session rm and count lease bytes in disk guard

Closes the M1 leak path outside cw gc and makes runaway caches visible to the budget.
EOF
)"
```

---

### Task 6: Lease visibility on `cw session list`

**Files:**
- Modify: `src/daemon/methods.ts` (`session.list` enrichment)
- Modify: `src/cli/commands/session.ts`
- Test: `tests/cli/session.test.ts` and/or daemon session list tests

**Interfaces:**

Each listed session may include:

```ts
leases?: {
  portBase: number | null;
  composeProject: string | null;
  cachePath: string | null;
  dbStrategy: 'none' | 'schema' | 'file-copy';
  dbValue: string | null;
}
```

CLI adds one extra tab field, e.g. `port=43000,compose=cw_<id>,cache=.crossweave/cache/<id>` (or `-` when no leases). Keep existing columns stable; document the new field in the command description.

Export a pure `formatLeaseSummary(leases): string` for unit tests.

- [ ] **Step 1: Write the failing tests** for `formatLeaseSummary` + list enrichment
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Write minimal implementation**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(cli): show port/cache/db lease summary on session list

Makes cooperative runtime isolation debuggable without opening the database.
EOF
)"
```

---

### Task 7: Refresh known-limitations digest + full gate

**Files:**
- Modify: `docs/superpowers/specs/2026-08-14-known-limitations-digest.md`
- Optional: one-line “fixed by Land & Lease Reliability” pointers in M1/M4 limitation docs

- [ ] **Step 1: Edit digest**

- Remove or rewrite “No TUI yet”.
- Note `cw config trust` exists for `testCommand`.
- State leases remain cooperative; agents ignoring env can still collide.
- Mark closed: `PORT` override via `ports.named`, cache/db leak on `session rm`, squash net-zero false failure, naive `land all` snapshot.

- [ ] **Step 2: Full gate**

Run: `bun test && bun run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
docs: refresh known-limitations after land/lease reliability work

Align the digest with shipped TUI, trust gate, and the gaps this phase closed.
EOF
)"
```

---

## Spec coverage checklist

| Spec requirement | Task |
|---|---|
| Evidence gate ready/unknown/blocked | 2, 3 |
| Fresh = trial base HEAD matches | 2 |
| Trusted testCommand ⇒ full-integration clean | 2, 3 |
| `land all` re-fetch after each land | 3 |
| Single error line on stop | 3 |
| Surface unverified vs clean | 3 |
| Squash no-op | 1 |
| Rebase stdout+stderr | 1 |
| Reserve `PORT` | 4 |
| Probe full port block | 4 |
| Dispose cache/db on rm/kill | 5 |
| Disk budget includes lease bytes | 5 |
| Lease visibility on list | 6 |
| Update known-limitations | 7 |
| No desktop / multi-pane | Global constraints |

## Out of scope reminders

- Thin desktop / multi-pane (phase 2 gate in the spec)
- Docker compose lifecycle / Postgres schema create
- Safe Mode Bash interception
- Schema-first OpenAPI RPC retrofit
