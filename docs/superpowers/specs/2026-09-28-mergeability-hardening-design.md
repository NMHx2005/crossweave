# Making N sessions mergeable again — passive overlap, setup hooks, a place to resolve — design (rev 2)

**Date:** 2026-09-28 · **Status:** approved (rev 2, after an independent code review)
**Plan:** `docs/superpowers/plans/2026-09-28-mergeability-hardening.md`

Rev 2 corrects rev 1 after a review that verified every claim against the code. The
corrections are listed inline as **rev 2** notes; see §7 for what drove them.

## Problem

The 2026-09-27 removal of Collision Radar, the OS sandbox, agent adapters and Safe
Mode left the product's own thesis — *"Make N parallel AI coding agents on one repo
safe and mergeable"* — resting on the Convergence Engine alone. Three gaps follow,
and none needs agent cooperation, native code, or a trust boundary the project has not
already established:

1. **Nothing warns about overlap until a trial merge conflicts.** By then both sessions
   have written the same file and one is redone by hand — the signal arrives after the
   work is expensive to change rather than while it is cheap.
2. **A fresh worktree is cold.** Every `cw session new` hands the user an empty
   dependency tree; they install and seed it by hand before the agent is usable.
3. **A conflict is a dead end in the UI.** `cw land` correctly refuses and says to merge
   the base into the session's branch *from its own worktree* — an instruction with no
   affordance: no button, no command, no scratch place to do it without disturbing a
   live agent.

## Goals

- A session's **overlapping paths** with other sessions are visible while the work is
  cheap to change.
- A new worktree can **set itself up** (install, seed, env) via a user-defined,
  explicitly-trusted command.
- A **conflict has an address**: open where the merge is, resolve, hand it back, re-trial.

## Non-goals

- A blocking guard, tiers or Safe Mode. Overlap is a signal, never a stop.
- Auto-resolving conflicts, or any agent in the loop. The user resolves.
- An OS sandbox. Hooks run as the user — trusted config, not contained.
- Symbol-level analysis. v1 is file-path overlap only; the dead `file_claim` /
  `contract` tables stay unused (forward-only migrations, not repurposed).

## Part A — Overlap signal (passive)

### Shape

Per active session, the set of paths it has touched: **committed**
(`git diff --name-only --no-renames <merge-base(HEAD,branch)>..<branch>`) ∪
**uncommitted** (paths from `git status --porcelain`, minus `.crossweave/`, as
`countChanged` already filters). Two sessions overlap when their sets intersect; the
per-session signal is `{ other: string; paths: string[] }[]`.

- **rev 2 — one scan, not two.** `readGitCounts` already runs `git status --porcelain`
  (`src/daemon/git-counts.ts`). A second `git status` for overlap would double the
  subprocesses per session per tick. So the per-folder scan is extended to return
  `{ changed, ahead, changedPaths, committedPaths }` (or a small `src/daemon/repo-scan.ts`
  owns it), and both `GitCounter` (counts) and the new `OverlapTracker` (paths) read
  from that single pass.
- **`src/domain/overlap.ts`** — pure `overlapPairs(sessions: { name; paths: string[] }[])`
  → `Map<name, {other, paths}[]>`. Deterministic (sort by other name, then path), deduped,
  exact-string POSIX paths. No I/O, tested to death.
- **`src/daemon/overlap.ts`** — an `OverlapTracker` shaped exactly like `GitCounter`:
  throttled background refresh (`minIntervalMs` ≈ 5000), served from memory, `refresh()`
  resolving `true` only when the overlap set changed, so the daemon can
  `broadcastRegistry.broadcast('tui.invalidate', {})`.
- **`session.list`** gains `overlaps?: { session: string; paths: string[] }[]`, attached
  in the same block as `git` / `usage` / `latestWords`, refreshed with the same
  `void …refresh(...)` pattern. Only worktree sessions participate
  (`worktreePath !== projectRoot`); shared sessions and plain folders carry none.

### Surface

- **Cockpit:** `ListedSession` gains `overlaps` **and the `parseSessionList` block must
  learn it** — rev 2: that parser is whitelist-only (`apps/cockpit/src/lib/sessions.ts`),
  so an unlisted field is dropped silently. Rail badge (`2 files · alice`) + tooltip;
  reciprocal mark on the other row; badge colour from a token (`tokens.test.ts` forbids
  literals).
- **CLI:** `cw overlap [--json]` prints `NAME <-> NAME  path, …`; `cw converge status`
  gains an `overlaps:` section, printed only when non-empty.

### Known limitations (to record on ship)

- File-level only (no line/symbol). A path in `git status` may be incidental.
- **rev 2 — the committed set shrinks as the base advances:** the merge-base moves
  forward, so a file the session touched that later landed in base drops out of
  `committedPaths`. Inherent to a diff-against-base signal; the uncommitted half is
  unaffected.

## Part B — Session setup hooks (warm-up)

### Shape

`crossweave.config.json` gains a top-level `hooks` object:

```json
{ "hooks": { "sessionSetup": "bun install && cp ../.env .env", "sessionTeardown": "docker compose down || true" } }
```

Validated in `src/core/config.ts`: each is a single line string if set; a non-string is
`CONFIG_INVALID`; merged one level over the defaults like every other config branch.

- **rev 2 — where it runs: at *first start*, typed into the shell.** rev 1 ran it in the
  background at `session.new` and streamed its output into "the session's scrollback" —
  **impossible**: no pty or scrollback exists until `SessionRuntime.start`
  (`src/daemon/runtime.ts`), and `session.new` only inserts a row. Instead the hook is
  typed into the shell through the existing `runLine` path
  (`methods.ts`: `runtime.write(row.id, row.name, run + '\r')`). This runs it in the
  user's real shell (aliases, PATH), puts its output in the real pty, and needs no
  background job to reconcile after a restart.
  - The hook is **`&&`-chained with the launch line** so a failed setup does not start
    the launcher on a half-installed tree: `hook.sessionSetup && <launcher|run>`, or the
    hook alone when neither is given.
  - One bit of run-once state (`session.setup_done`, forward-only) so later starts do not
    re-run it. Far simpler than rev 1's `running/ok/failed` + boot reconcile.
- **Teardown:** `sessionTeardown` runs best effort in the worktree before `session.rm` /
  `gc` removes it; a failure is a warning, the removal still happens.

### Trust (split — rev 2)

`converge.testCommand`'s rule stands: arbitrary shell from a repo-controlled file must be
explicitly trusted per exact string, keyed by hash. Hooks are the same class:

- **Schema:** `ALTER TABLE config_trust ADD COLUMN hooks_hash TEXT` (nullable, forward-only).
- `hashHooks(hooks)` = sha256 over a canonical serialization, so any edit re-locks;
  `isHooksTrusted` compares it.
- **rev 2 — trust is split.** `cw config trust` keeps trusting only `testCommand`; a new
  `cw config trust hooks` trusts the hooks. Reason: `testCommand` runs only on
  `cw land --yes`, while `sessionSetup` runs automatically on every start — gating them
  together would let a user trusting their test command unknowingly arm a hook a hostile
  clone added. Least privilege wins.
- Untrusted → the hook is **skipped and the reason recorded** (never silently ignored),
  mirroring `LAND_TESTCOMMAND_UNTRUSTED`.
- `cw config status` reports each separately; `cw config untrust` clears both.
- **rev 2 — `config.trust` must be generalised:** today it throws
  `CONFIG_NO_TEST_COMMAND` when no test command is set (`methods.ts`), so a user with only
  hooks cannot trust anything.

### CLI

- `cw session setup <name>` — re-run the configured `sessionSetup` now (fresh trust
  check), reporting exit code + output tail.
- `cw session list` shows a setup state column only when any session has one.

### Known limitations (to record on ship)

- Hooks run as the user, unsandboxed (trusted config, not contained).
- Setup output lives in the pty, so it is not surfaced on the rail before the shell opens.
- No array / conditional hooks in v1; one line per event.

## Part C — A place to resolve a conflict

### Shape

`src/convergence/resolution-worktree.ts`:

- `ensureResolutionWorktree(workspaceId, sessionId)` → `.crossweave/resolve/<sessionId>`
  on branch `cw/resolve/<name>`, forked from the session's branch. Serialized by a lock
  keyed by **sessionId** (the `withIntegrationWorktreeLock` pattern), so it never races
  the scheduler's integration worktree — which it does not touch at all.
- **rev 2 — no session row, no lease.** Resolving needs neither a port nor the DB, so the
  resolve worktree is not a session. This is what makes C-3 disappear (§7): rev 1 tried to
  hide it "like `cw/integration`" while also opening a terminal in it, but
  `terminal.open → sessions.resolve()` throws for `agentKind === 'integration'`
  (`src/domain/session.ts`), so the two could not both hold.
- `startResolution`: `git merge <baseHead>` left **in progress** (markers + `MERGE_HEAD`);
  returns `{ path, conflicts }` (`git diff --name-only --diff-filter=U`).
- `finishResolution` (**gated — rev 2**):
  - session must be **stopped** and its worktree **clean**
    (`RESOLVE_SESSION_LIVE` / `RESOLVE_SESSION_DIRTY`);
  - the resolve branch must be a superset of the session branch
    (`git merge-base --is-ancestor`, else `RESOLVE_STALE`);
  - **fast-forward inside the session's worktree**:
    `git -C <sessionWorktree> merge --ff-only cw/resolve/<name>`. rev 1's
    `git branch -f <sessionBranch>` **fails** — the branch is checked out there;
  - tear the resolve worktree/branch down; nudge a re-trial so the row flips
    `conflict → unknown → ready`.
- `abortResolution`: tear down only; the session branch is untouched even mid-conflict.

**Opening a shell there (rev 2):** a new local-only RPC `terminal.openResolve
{ workspaceId, idOrName }`. `TerminalRegistry.open` gains an optional explicit `cwd`
(default stays `row.worktreePath`); it reports `sessionId` = the **owning** session's id,
so the cockpit groups the pane under that session and `closeForSession(owner)` cleans it
up. Containment: the path must be inside `.crossweave/` (`assertContained` + prefix check).

### CLI

`cw converge resolve <name> [--finish | --abort]`; start prints the path + conflicts.

### Known limitations (to record on ship)

- `--finish` **does** touch the session worktree (start/abort do not) — only under the
  stopped + clean gate.
- The in-app file editor does not open the resolve path in v1 (terminal only).
- A base that moves between start and finish is not detected; the re-trial simply
  conflicts again.

## 4. Cross-cutting

- Schema (forward-only, one statement each): `session.setup_done`, `config_trust.hooks_hash`.
- No new native modules. RPC additions only — `overlaps` on `session.list`; new
  `session.setup`, `converge.resolve`, `terminal.openResolve`. Nothing removed or renamed.
- Each part ships `docs/superpowers/specs/<date>-*-known-limitations.md` + a digest line;
  `AGENTS.md`'s map gains `src/domain/overlap.ts`, `src/daemon/overlap.ts`,
  `src/domain/session-setup.ts`, `src/convergence/resolution-worktree.ts`.

## 5. Test strategy

Pure logic (overlap pairing, hook hashing, setup state, resolution state) is unit-tested
with fakes for I/O. Daemon wiring is tested through the real RPC table with a temp repo.
Cockpit changes (rail badge, Resolve button) get a rail/land-actions test **and** a look
at the running app. No test asserts a log string or a private internal.

## 6. Rollout

Three parts, in order A → B → C (A read-only and lowest-risk, B the one new
code-execution path, C the most stateful). One branch each; each ends at the gate and a
report to the user before the next part.

## 7. What the review changed (rev 1 → rev 2)

| # | rev 1 | rev 2 (verified against code) |
|---|---|---|
| A-1 | overlap rereads `git status` | one shared scan feeds both consumers |
| A-3 | daemon + rail | cockpit `parseSessionList` is whitelist-only — must learn `overlaps` |
| B-1 | run at `session.new`, stream to scrollback | no pty exists at `session.new`; run at first start, typed via `runLine` |
| B-2 | — | `config.trust` dead-ends without a testCommand — generalise |
| B-3 | `setup_status` + boot reconcile | dropped — a run-once bit replaces it |
| B-4 | one `cw config trust` | split: `cw config trust hooks` (blast radius) |
| C-1 | `git branch -f` | fails on a checked-out branch → `merge --ff-only` in the worktree |
| C-2 | — | `--finish` needs a stopped session + clean worktree |
| C-3 | hide "like `cw/integration`" + terminal works | contradiction; resolve is not a session row |
| C-4 | — | base moving between start and finish is a documented limitation |

## Gate (per part)

`bun run typecheck` · `bun test --max-concurrency=1` · `bun run build`
(+ cockpit `bun test` + `bun run build`, with a look at the running app, for Part A5 / C6).
