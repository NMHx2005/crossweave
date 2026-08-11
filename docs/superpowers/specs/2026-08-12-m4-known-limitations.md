# crossweave M4 — known limitations

Accepted gaps carried out of M4 ("Convergence Engine"), for M5 and beyond.
Each was found, evaluated, and deliberately deferred (not overlooked) during
subagent-driven implementation and two rounds of whole-branch review — see
`.superpowers/sdd/2026-08-11-crossweave-m4-convergence-engine/progress.md`
for the full task-by-task ledger this doc summarizes.

## Security — needs a human decision before `converge.testCommand` is
## recommended for real use

**`converge.testCommand` auto-executes an arbitrary shell command sourced
from `crossweave.config.json` — a file checked into the repo itself — with
no trust prompt, no opt-in, and no sandboxing.** This exists at two call
sites, both `Bun.spawn(['sh', '-c', config.converge.testCommand], { env:
{ ...process.env, ...leaseEnv } })`:

- `ConvergenceScheduler`'s periodic full-integration trial (`src/daemon/convergence-scheduler.ts`)
- `cw land`'s own pre-merge test run (`src/convergence/land.ts`)

The exposure, named precisely:

1. **It is unattended on the scheduler path.** `git clone` a repo containing
   a `crossweave.config.json` with `converge.testCommand` set, run `cw
   daemon start` (or just have ≥2 active sessions with an already-running
   daemon), and within `converge.fullIntegrationIntervalMs` (default 5
   minutes) the daemon executes that string through `sh -c`. No prompt, no
   confirmation, no trust-on-first-use check.
2. **The config file is exactly the thing an untrusted clone controls.**
   This is the same class of hazard `.vscode/tasks.json` auto-run,
   `.envrc`/direnv, and unpinned build-tool wrapper scripts are all known
   for.
3. **It inherits the full parent process environment** (`...process.env`)
   — every credential available to the daemon process is available to
   whatever this command does.
4. **The `cw land` path is arguably worse**, because it runs at exactly the
   moment the user has already typed a destructive, `--yes`-confirmed
   command — any prompt fatigue from that confirmation is already spent,
   and the test run's result directly gates an irreversible merge.

**This needs an explicit decision, not a default.** Options on the table,
none implemented: trust-on-first-use with a recorded hash of the command
string (re-prompt if it changes); require `converge.testCommand` to live in
a gitignored local override rather than the committed config; an explicit
`cw config trust` gate before the daemon will ever read `converge.*` from a
newly-seen `crossweave.config.json`. "Do nothing" (today's behavior) is a
legitimate choice for a single-user local tool, but it should be chosen
deliberately and documented as such, not left as an implicit default nobody
decided on.

## Convergence Engine — narrow gaps in the squash-strategy no-op detection

- **A branch whose commits net to zero diff against base (but aren't
  literally zero commits) still fails `LAND_MERGE_FAILED` under the default
  `squash` strategy.** The fix that landed catches the common case (`git
  rev-list --count base..branch` is `0`) but not the rarer one where the
  branch has commits whose combined effect already exists on base (e.g. two
  sessions independently made the identical change, and one already landed).
  `git merge --squash` there reports "Automatic merge went well" but the
  index ends up unchanged, and the follow-up commit fails with "nothing to
  commit". The recovery path (`git reset --hard base`) leaves the main
  checkout clean — this is a spurious batch-halting error, not corruption —
  but it can stop a `cw land all` run partway through. A `git diff --cached
  --quiet` check immediately after `merge --squash` (in addition to the
  existing `rev-list --count` check) would close this.

## Convergence Engine — timing/staleness edges around the new worktree lock

M4's final review found and fixed a Critical bug where the background
scheduler and `cw land` shared the scratch integration worktree with no
mutual exclusion (a per-workspace async mutex now serializes all access —
see `withIntegrationWorktreeLock` in `src/convergence/integration-worktree.ts`).
Two narrower timing edges remain, both assessed as non-corrupting:

- **The scheduler captures the base branch's HEAD *before* acquiring the new
  lock.** If a `cw land` holds the lock and moves the base branch while a
  waiting scheduler tick is queued behind it, that tick trials against the
  now-stale base SHA it captured earlier. The result is a stale `merge_trial`
  row (feeding `cw converge status` with slightly outdated information), not
  a corrupted worktree — the lock still fully serializes the actual git
  operations. This is a variant of an already-accepted pre-existing gap
  (`triedPairs`' debounce keys don't account for base moving either, only
  for a session branch's own head changing) rather than a new one introduced
  by the lock.
- **The scheduler's `tick()` awaits each workspace sequentially**, so a
  long-running `converge.testCommand` held by a `cw land` in one workspace
  now stalls the scheduler's tick for every *other* workspace too, until the
  lock releases — partially defeating the purpose of keying the lock
  per-workspace rather than globally. No pile-up (the scheduler's own
  `running` guard prevents overlapping ticks), no corruption, and RPCs are
  dispatched independently so a blocked tick never blocks a `land.session`
  call. Single-workspace usage — the common case for this tool — is
  unaffected. Worth revisiting if multi-workspace-per-daemon usage becomes
  real (parallelizing `tick()`'s per-workspace loop rather than awaiting it
  sequentially).

## Narrower, previously-documented gaps carried from individual tasks

- The integration worktree's coalescing cache (`ensureIntegrationWorktree`,
  Task 2) is keyed by `workspaceId` alone, ignoring `db`/`projectRoot` —
  unreachable today (one database, one project root per daemon instance in
  practice), worth remembering if a future caller ever passes a per-request
  database handle.
- `src/domain/gc.ts` and `src/domain/ledger.ts` still call
  `SessionRepo.listByWorkspace` directly, unfiltered for the integration
  session row — the same leak class as the fix already applied to
  `WorkspaceManager.info` and `SessionManager.list`/`resolve`. Harmless for
  both current callers (`gc` only acts on `dead`/`landed` sessions, and the
  integration row is never either; `ledger`'s commit-sync arguably *should*
  see it), but worth closing for consistency if either function grows.
- `git merge --no-verify` (used to bypass hooks/signing on the scratch
  worktree's throwaway intermediate commits) needs git ≥2.36 (2021). An
  older git would silently reproduce the original false-conflict bug this
  flag exists to prevent. Not triggered in this project's CI (git 2.50.1
  throughout development).
- `LAND_REBASE_CONFLICT` error messages don't name the specific conflicting
  file — `git`'s rebase-conflict diagnostics land on stdout, but the error
  capture in `src/convergence/land.ts` prefers stderr (correct for the
  squash/plain-merge cases, where conflict output IS on stdout and stderr is
  empty, so the preference doesn't shadow it there — but rebase populates
  both streams, and stderr's content for a rebase conflict is generic hint
  text, not the file list). Not a regression from any fix in this milestone;
  concatenating both streams instead of preferring one would close it.
- `buildConflictGraph` and `converge.status`'s independent pairwise-matrix
  computation can theoretically disagree on which trial "wins" an exact
  timestamp tie between two rows for the same branch pair — one keeps the
  first-encountered row, the other the last, so in a true tie they resolve
  in opposite directions. Entirely unexercised (SQL doesn't guarantee
  tie-order stability to depend on either way), but worth a shared
  tie-break rule (e.g. also order by `id`) if it's ever hit in practice.
- `cw land all`'s per-session failure is currently printed twice — once
  plain on stdout inside the CLI's loop, once with its error code via the
  standard `fail()` path on stderr when the loop's exception propagates.
  Redundant, not incorrect.
