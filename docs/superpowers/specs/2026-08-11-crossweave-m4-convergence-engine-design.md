# crossweave M4 — Convergence Engine design

**Date:** 2026-08-11
**Status:** Design, pending plan. Builds on M0–M3 (merged to `main`). Elaborates
`docs/superpowers/specs/2026-08-09-crossweave-design.md` §4.9 (Convergence
Engine), §3 (data model), §5.4 (destructive operations), §8 (M4 testing row)
into an implementable spec.

## 1. Why this milestone

M3 tells two sessions they're touching the same thing. It cannot tell them
whether their work actually merges. Convergence Engine closes that loop:
it continuously trial-merges every active session's branch against every
other, in the background, so a conflict is known **before** either session
finishes — and it gives the terminal operation, `cw land`, that actually
gets a session's work into the base branch safely.

## 2. Scope for M4 (decided)

**In scope:** continuous pairwise trial-merge with a conflict graph, a
merge-order recommendation, periodic full-integration merge + optional test
run, `cw converge status`, and `cw land` / `cw land --all`.

**Deferred, not in M4:** the design doc's intent-aware auto-resolver (spawn a
dedicated agent session to resolve a detected conflict, seeded with both
diffs and each session's "stated intent" from the Context Store). This is a
live agent-spawning feature, not infrastructure, and the design doc doesn't
fully specify its trigger — explicitly deferred to a later milestone rather
than guessed at now. Because it's deferred, M4 also does **not** need to
design any "stated intent" capture mechanism — that requirement only existed
to feed the resolver.

## 3. Data model

New migration (current `SCHEMA_VERSION` is 5 as of M3's final-review fix
wave; this migration bumps it to 6):

```sql
CREATE TABLE merge_trial (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  ts           TEXT NOT NULL,
  branches     TEXT NOT NULL,   -- JSON array of branch names, 2 for a pairwise trial, N for full-integration
  result       TEXT NOT NULL CHECK (result IN ('clean','conflict','test_fail','unverified')),
  detail       TEXT             -- conflicting file list (conflict), test output tail (test_fail), NULL otherwise
)
```

`event.kind`'s CHECK constraint widens to add `'session.landed'` (copy-drop-
rename, matching every prior widening of this same column since M2).

`merge_trial` is append-only, like `event` — every trial run writes a new
row, never updates one in place. The conflict graph and `cw converge
status` read the **latest** row per branch-pair from this history; older
rows stay for audit/debugging, matching this project's established
append-only-ledger posture (`event`, `file_claim` history is not, but
`merge_trial` — being a decision record, not a live-state cache — follows
`event`'s model instead).

## 4. The scratch integration worktree

One worktree at `.crossweave/integration`, on a dedicated branch
(`cw/integration`), created lazily on the first trial the daemon needs to
run (not at every daemon boot — most daemon lifetimes never need it, e.g. a
single-session workspace).

It **holds a lease**, exactly as a session does (§4.4 continuity) — running
tests there must not collide with live sessions on ports/db/docker/cache.
Since `lease.session_id` is a foreign key into `session(id)`, the
integration worktree gets a real (internal-use) `session` row:
`agent_kind: 'integration'`. No new `status` value or schema change is
needed for it — its `status` stays `'idle'` between trials and `'running'`
only for the duration of an actual test-command execution, exactly
mirroring a real session's lifecycle, reusing the existing enum as-is. It is
never returned by `cw session list` (filtered out by `agent_kind !==
'integration'`) and never resolvable as a target of `cw session start`/
`kill`/messaging — it exists purely so the lease FK has a row to point at.

## 5. Trial-merge scheduling

The design doc frames trial-merge as **time-boxed budgets** ("debounced at
30s per branch", "at most once per 5 minutes"), not file-change events —
unlike M3's Radar, which reacts to working-tree writes. A trial-merge only
cares about **committed** state (you cannot `git merge` uncommitted work),
so this is a periodic reconciliation, not an `fs.watch` reaction:

- A `ConvergenceScheduler` in the daemon ticks every 5s (an internal
  `setInterval`, not user-configurable — it is just the granularity of the
  time-boxed checks below, not a cost driver itself).
- Each tick: for every active (`running`/`idle`) session with a worktree,
  read its branch's current HEAD (`git rev-parse <branch>`). If that HEAD
  differs from the HEAD the last trial involving this branch used, **and**
  at least `converge.trialDebounceMs` (default 30 000) has passed since
  that branch's last trial, the branch is due.
- For every due branch, enqueue one pairwise trial against every OTHER
  active branch not already trialled against this exact HEAD pair. Jobs run
  serially through one FIFO queue — the scratch worktree can only run one
  `git merge` at a time.
- Separately, at most every `converge.fullIntegrationIntervalMs` (default
  300 000 = 5 min), and only when the **most recent pairwise round found no
  conflicts** (matching "a conflicting merge never reaches the test
  phase"), a full-integration trial merges every active branch together and,
  if that merge is clean, runs `converge.testCommand` (if configured).
- **Degrade threshold**: above `converge.pairwiseSessionThreshold` (default
  8) active sessions, pairwise trials stop running entirely — only the
  full-integration trial runs — and `cw converge status` says so explicitly
  ("N sessions active; pairwise trials disabled above 8, showing
  full-integration only") rather than silently thinning coverage.

## 6. Merge-trial mechanics — exact git sequence

Every trial runs in `.crossweave/integration`, never in a session's own
worktree or the main checkout:

```bash
git checkout -B cw/trial <base-branch-head-at-trial-start>
git merge --no-commit --no-ff <branchA>
# conflict here -> record {branches:[A], result:'conflict', detail:<conflicted files>}, git merge --abort, stop
git merge --no-commit --no-ff <branchB>
# conflict here -> record {branches:[A,B], result:'conflict', detail:<conflicted files>}, git merge --abort, stop
# both clean -> record {branches:[A,B], result:'clean'}
git reset --hard <base-branch-head-at-trial-start>   # leaves the worktree clean for the next job in the queue
```

For the full-integration trial, the same pattern extends to every active
branch in sequence; a clean result is followed (still holding the merged
worktree state, no reset yet) by running `converge.testCommand` via
`Bun.spawn` with `cwd` set to the integration worktree, before the final
`git reset --hard`. `test_fail` records the command's combined stdout/stderr
tail (capped, matching this project's existing size-cap conventions) as
`detail`. `unverified` is recorded instead of `clean` when the merge itself
was clean but `converge.testCommand` is unset — **never** a `clean` result
derived from a test that did not run.

## 7. Conflict graph and merge order

The conflict graph is built from the **latest** pairwise `merge_trial` row
per branch pair (not the full history) at query time — no separate graph
table. An edge exists between two sessions iff their latest pairwise trial's
`result` is `'conflict'`.

Recommended order: sort active sessions by degree (count of conflicting
partners) ascending — "merge the branches with the fewest conflicting
partners first," exactly as specified. Ties break by `created_at` ascending
(oldest session first), matching every other ordering convention already in
this codebase (`SessionRepo.listByWorkspace`, etc.).

## 8. `cw converge status`

New RPC `converge.status(workspaceId)` returns: the pairwise conflict matrix
(session pairs + their latest trial result), the latest full-integration
result (or `null` if none has run yet), and the recommended merge order. The
CLI command prints this as a simple table — no TUI-level visualization in
M4 (that's §4.12, M6).

## 9. `cw land <session>` / `cw land --all`

Exactly the design doc's 5 steps, now made concrete:

1. Refuse if the session's `status` is `'running'`, unless `--force` is
   passed — reusing the existing `SESSION_STILL_LIVE`-style error shape.
2. Re-run a **fresh** two-way trial merge of that branch against the base
   branch's **current** HEAD (a simple `git merge --no-commit --no-ff` in
   the scratch worktree, §6's mechanics minus the second branch — not a
   cached `merge_trial` row, which could be stale, and not a pairwise
   trial against another session's branch) — refuse with a `LAND_CONFLICT`
   error listing the conflicting files if it doesn't merge cleanly. (No
   resolver session is spawned — that's the deferred feature; the error
   message just names the conflict.)
3. If `converge.testCommand` is configured, run it in the integration
   worktree against that fresh merge; refuse with `LAND_TEST_FAILED` if it
   fails. If unset, proceed — landing without a configured test command is
   allowed, matching "reports `unverified` rather than success," not
   "refuses."
4. Merge the session's branch into the **base branch itself**, in the
   **main checkout** (not the scratch worktree — this is the real, durable
   integration), using `converge.mergeStrategy` (`'merge' | 'squash' |
   'rebase'`, default `'squash'` — "one agent session reads naturally as one
   logical change").
5. Release the session's leases, remove its worktree (after confirmation —
   see below), mark `status: 'landed'`, and append a `session.landed` event.

`cw land --all` lands every session with no live conflict edge in the
current conflict graph, in the recommended order from §7, **stopping at the
first failure** rather than continuing past it.

**Confirmation**: `cw land` is destructive and outward-facing (§5.4) — it
always confirms interactively unless `--yes` is passed. It never
force-pushes and never rewrites shared history — every git operation here
is a plain local `merge`/`rebase` against the user's own base branch, never
touching a remote.

## 10. Config additions

```ts
// CrossweaveConfig, src/core/config.ts
converge: {
  testCommand?: string;               // no default, no inference
  mergeStrategy: 'merge' | 'squash' | 'rebase'; // default 'squash'
  trialDebounceMs: number;            // default 30_000
  fullIntegrationIntervalMs: number;  // default 300_000
  pairwiseSessionThreshold: number;   // default 8
}
```

## 11. Testing (per the design doc's M4 row, §8)

- A trial merge reports a cross-session conflict before either branch
  lands (two session worktrees, real git fixture, genuinely conflicting
  edits, `merge_trial` shows `conflict` for that pair).
- The recommended order reduces total conflict count against a naive
  (creation-order) order, on a fixture with a known conflict graph shape.
- `cw land` refuses on conflict (with the conflicting files named), refuses
  on a running session, and reports `unverified` rather than success when
  `converge.testCommand` is unset.
- `cw land --all` stops at the first failure rather than continuing past
  it.
- The scratch worktree's lease is genuinely held (a live session and the
  integration worktree never get the same port/db/docker slot).
- `unverified` is never upgraded to `clean`/success by any code path when
  no test command ran.
