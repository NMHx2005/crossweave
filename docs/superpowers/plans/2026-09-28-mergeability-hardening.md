# Plan — making N sessions mergeable again (rev 2)

**Design:** `docs/superpowers/specs/2026-09-28-mergeability-hardening-design.md`
**Date:** 2026-09-28 · **Status:** approved (rev 2)

Three parts, in order A → B → C: A is read-only and lowest-risk, B introduces the one new
code-execution path, C is the most stateful. One branch per part
(`feat/overlap-signal`, `feat/session-hooks`, `feat/conflict-resolve`).

Every part: TDD (RED→GREEN per task, no placeholders). Each task is its own commit
(Conventional Commits, what + why). Then the gate below, a
`docs/superpowers/specs/<date>-*-known-limitations.md` + a digest line, and a report to the
user **before** the next part starts. `main` stays linear; every merge and push needs the
user's explicit OK.

Gate: `bun run typecheck` · `bun test --max-concurrency=1` · `bun run build`
(+ `apps/cockpit`: `bun test` + `bun run build` and a look at the running app for A5 / C6).

---

## Part A — Overlap signal

### A1. `src/domain/overlap.ts` — the pure pairing
- **RED** `tests/domain/overlap.test.ts`: two sessions sharing one path → each names the
  other with just that path; disjoint → empty map; a path shared by three → returned by
  all three; a session with no paths → nothing; duplicate paths deduped; deterministic
  order (by other name, then path).
- **GREEN**: pure function, exact-string POSIX paths.

### A2. Shared scan + `OverlapTracker`
- **RED** `tests/daemon/overlap.test.ts` (fake reader of fixed path sets): `refresh()`
  true only when the overlap set changed; a second call inside `minIntervalMs` false
  without reading; a session gone from `targets` dropped (counts as change); a call while
  one is running skipped. Mirrors `tests/daemon/git-counts.test.ts`.
- **GREEN**: extend `readGitCounts`/add `src/daemon/repo-scan.ts` to also return
  `changedPaths` + `committedPaths`; `OverlapTracker` reads them. `tests/daemon/git-counts`
  stays green.

### A3. Wire `session.list`
- **RED** `tests/daemon/methods-overlap.test.ts`: two overlapping worktree sessions each
  carry `overlaps`; a shared session and a plain folder carry none; a lone session none.
- **GREEN** `src/daemon/methods.ts`: refresh the tracker next to `gitCounts.refresh`, attach
  `overlaps` from cache.

### A4. CLI
- **RED** `tests/cli/overlap.test.ts`: `cw overlap` prints each pair once; `--json`
  round-trips; empty → `no overlaps`. `converge status` prints `overlaps:` only when non-empty.
- **GREEN** `src/cli/commands/overlap.ts` (new) + a section in `src/cli/commands/converge.ts`.

### A5. Cockpit rail badge
- **RED** `apps/cockpit/tests/rail.test.ts`: `parseSessionList` keeps `overlaps`; a row
  renders the badge + tooltip; the other row the reciprocal mark.
- **GREEN** `apps/cockpit/src/lib/sessions.ts` + `Sidebar.tsx` + a badge token in `tokens.ts`.

**Gate A** + `2026-09-28-overlap-signal-known-limitations.md` + digest line → report.

---

## Part B — Session setup hooks

### B1. Config
- **RED** `tests/core/config-hooks.test.ts`: `hooks.sessionSetup`/`sessionTeardown` parse;
  non-string → `CONFIG_INVALID`; absent → undefined; one-level merge, no sibling loss.
- **GREEN** `src/core/config.ts`.

### B2. Trust + migration
- **RED** `tests/db/migration-hooks-hash.test.ts` (column exists; old rows NULL);
  `tests/convergence/trust-hooks.test.ts` (`hashHooks` stable/changes; `isHooksTrusted`).
- **GREEN** migration + `ConfigTrustRepo` (`hooks_hash`) + `hashHooks`/`isHooksTrusted`.

### B3. Trust CLI + generalised handler
- **RED** `tests/cli/config-hooks.test.ts`: `cw config trust hooks` trusts hooks only;
  `cw config trust` with no testCommand no longer errors (trusts nothing, says so); editing
  hooks re-locks; `untrust` clears both; `status` shows each.
- **GREEN** `config.trust`/`config.status`/`config.untrust` + `src/cli/commands/config.ts`.

### B4. The runner
- **RED** `tests/domain/session-setup.test.ts`: exit 0 → ok; non-zero → failed + tail; no
  hook → no-op; untrusted → skipped with a reason (not run); `sh -c` with the merged env;
  output tail bounded.
- **GREEN** `src/domain/session-setup.ts`.

### B5. First-start typed run + run-once bit
- **RED** `tests/daemon/session-setup-wire.test.ts`: a worktree session with a trusted
  `sessionSetup` gets it typed (`&&`-chained with the launch line) on its first start only;
  `setup_done` set; a second start types only the launch line.
- **GREEN** the start path in `src/daemon/methods.ts` + `setup_done` migration.

### B6. `session.setup` RPC + CLI
- **RED** `tests/cli/session-setup.test.ts`: `cw session setup <name>` re-runs, reports
  exit code + tail; `cw session list` shows the column only when any session has a state.
- **GREEN** the RPC + `src/cli/commands/session.ts`.

### B7. Teardown hook
- **RED** `tests/daemon/session-teardown.test.ts`: `session.rm` / `gc` run `sessionTeardown`
  before removal; a failure warns and removal still happens; untrusted → skipped with a reason.
- **GREEN** `src/domain/gc.ts` / `src/domain/session.ts`.

**Gate B** + `2026-09-28-session-hooks-known-limitations.md` + digest line → report.

---

## Part C — Conflict resolution worktree

### C1. `ensureResolutionWorktree` + per-session lock
- **RED** `tests/convergence/resolution-worktree.test.ts`: idempotent; a stale row/dir
  recreated; two callers coalesce; the lock serializes use; not a session row (absent from
  `session.list`).
- **GREEN** `src/convergence/resolution-worktree.ts` (no session row, no lease).

### C2. `startResolution`
- **RED** `tests/convergence/resolution-start.test.ts`: fork `cw/resolve/<name>` from the
  session branch; a non-conflicting base → clean, `conflicts: []`; a conflicting base →
  markers + `MERGE_HEAD` + `conflicts` lists unmerged paths.
- **GREEN**.

### C3. `finishResolution`
- **RED** `tests/convergence/resolution-finish.test.ts`: refuses `RESOLVE_SESSION_LIVE`,
  `RESOLVE_SESSION_DIRTY`, `RESOLVE_STALE`; on success fast-forwards the session branch
  in-place (`merge --ff-only`), removes worktree + branch, reports a re-trial requested.
- **GREEN**.

### C4. `abortResolution`
- **RED** `tests/convergence/resolution-abort.test.ts`: worktree/branch gone; the session
  branch unchanged even mid-conflict.
- **GREEN**.

### C5. RPC + CLI
- **RED** `tests/cli/converge-resolve.test.ts`: start prints path + conflicts; `--finish`
  / `--abort` map to actions; unknown action → `INVALID_ARGUMENTS`; local clients only.
- **GREEN** `converge.resolve` handler + `src/cli/commands/converge.ts`.

### C6. Terminal in the resolve worktree + cockpit
- **RED** `tests/daemon/terminal-resolve.test.ts`: `terminal.openResolve` spawns with cwd =
  the resolve path, reports the owning session id, and refuses a path outside `.crossweave/`.
  `apps/cockpit/tests/land-actions.test.ts` / `rail.test.ts`: a `conflict` row shows Resolve;
  Finish/Abort call the RPC.
- **GREEN** `TerminalRegistry.open({cwd})` + `terminal.openResolve` + cockpit wiring.

**Gate C** + `2026-09-28-conflict-resolve-known-limitations.md` + digest line → report.

---

## Reporting

A → report → B → report → C → report. No merge or push without the user's OK.
