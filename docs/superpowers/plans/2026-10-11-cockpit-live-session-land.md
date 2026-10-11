# Cockpit Live Session Land Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` and complete each task in order. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow an explicitly confirmed, clean running session to be stopped and landed from Cockpit without silently discarding uncommitted work.

**Architecture:** Keep the daemon's existing force-stop-and-land behavior. Make `session.diff` preserve unreadable uncommitted state as `null`, then add a Cockpit preflight that blocks dirty or unknown state and a confirmation that authorizes force only for that session. Retain the existing convergence, check, and sensitive-file gates.

**Tech Stack:** TypeScript, Preact, Electron preload bridge, Bun test, daemon RPC.

**Spec:** `docs/superpowers/specs/2026-10-11-cockpit-live-session-land-design.md`

## Global Constraints

- `cwd` remains the only owner of session processes and database state; Cockpit calls the daemon through its closed bridge.
- `SessionDiff.uncommitted` is nullable: `null` means git status could not be read and must never be treated as a clean worktree.
- Do not add dependencies or native modules.
- A force stop is destructive to the running process and therefore requires an explicit, session-specific confirmation.
- Never translate confirmation for unknown convergence into RPC `force`; they are separate decisions.
- Preserve `landSelected` evidence rules and `Land all ready` behavior.
- Run Cockpit gates sequentially and use the real app/scratch project only for a live UI check.

---

### Task 1: Make uncommitted status fail closed

**Files:**
- Modify: `src/domain/session-diff.ts`
- Test: `tests/domain/session-diff.test.ts`
- Modify: `apps/cockpit/src/lib/patch.ts`, `apps/cockpit/src/lib/compare.ts`
- Modify: `apps/cockpit/src/ui/ChangesPane.tsx`, `apps/cockpit/src/ui/CompareView.tsx`
- Test: `apps/cockpit/tests/compare.test.ts`

- [x] **Step 1: Add a failing domain test for a broken worktree gitdir**

Create a worktree directory whose `.git` file points to a nonexistent gitdir, then call `sessionDiff` against a valid branch in the project root. Assert that `uncommitted` is `null` rather than `0`.

- [x] **Step 2: Change the session diff contract**

Change `SessionDiff.uncommitted` from `number` to `number | null`. Return `null` when `git status --porcelain` fails; keep `0` for a successfully read clean worktree and a positive count for known changes.

- [x] **Step 3: Carry nullable state to Cockpit**

Update the renderer parser and compare types to preserve `null`. In Changes and Compare, render an explicit “uncommitted status unavailable” message for `null`; retain the current count copy for positive values and no count for zero.

- [x] **Step 4: Add a renderer contract test**

Extend `apps/cockpit/tests/compare.test.ts` to verify an unavailable count remains unknown in comparison data, never becomes `0`.

- [x] **Step 5: Run focused domain and Cockpit tests**

Run: `bun test tests/domain/session-diff.test.ts --max-concurrency=1`

Then run: `cd apps/cockpit && bun test tests/compare.test.ts --max-concurrency=1`

Expected: unreadable git status remains unknown and existing clean/dirty cases retain their counts.

### Task 2: Pin the pure evidence and force contract

**Files:**
- Modify: `apps/cockpit/src/lib/land-actions.ts`
- Test: `apps/cockpit/tests/land-actions.test.ts`

- [x] **Step 1: Add a failing test for explicitly authorized live land**

Test that a ready session invokes the supplied land callback with live-stop authorization only when the caller passes the explicit option. Also test that `forceUnknown: true` alone does not authorize live-stop force.

- [x] **Step 2: Add a failing test for unknown evidence**

Verify an unknown session first returns `needs_confirm_unknown` without invoking land, even when the live-stop option is present; after the caller opts into unknown evidence, the callback receives live-stop authorization.

- [x] **Step 3: Add a failing test for blocked evidence**

Verify blocked status never invokes land regardless of either explicit option.

- [x] **Step 4: Implement the narrow option**

Extend `landSelected` with an explicit `forceLive?: boolean` option and the callback contract `land(name, forceLive?)`. Keep `forceUnknown` independent and preserve existing callers by defaulting both options off.

- [x] **Step 5: Run the focused tests**

Run: `cd apps/cockpit && bun test tests/land-actions.test.ts --max-concurrency=1`

Expected: all existing and new land-decision cases pass.

### Task 3: Preflight uncommitted files and explain stop-and-land

**Files:**
- Modify: `apps/cockpit/src/ui/ProjectView.tsx`
- Read: `apps/cockpit/src/host/cockpit-api.ts`
- Create: `apps/cockpit/src/lib/live-land.ts` with `authorizeLiveLand({ uncommitted, confirm })`, returning `needs_commit | status_unknown | cancelled | confirmed`.
- Create: `apps/cockpit/tests/live-land.test.ts` for the preflight decision sequence.

- [x] **Step 1: Add a failing test for dirty session work**

Given a running session whose `sessionDiff` returns `uncommitted > 0`, verify `authorizeLiveLand` returns `needs_commit`, does not call `confirm`, and the caller does not invoke `landSession`.

- [x] **Step 2: Add a failing test for unknown status**

Given `uncommitted: null`, verify the helper returns `status_unknown`, does not ask to stop, and does not call `landSession`.

- [x] **Step 3: Add a failing test for canceling stop-and-land**

Given a clean running session, decline the injected confirmation callback and verify neither stop nor land occurs.

- [x] **Step 4: Add a failing test for idle sessions**

Verify an idle session does not receive the new stop prompt and still uses the existing evidence-gated path.

- [x] **Step 5: Add the live-session preflight**

Before any destructive action, read `sessionDiff(target.id)` and pass its nullable `uncommitted` count to `authorizeLiveLand`. For positive or unknown counts, show the corresponding instruction and return without stopping. For zero uncommitted files, show one explicit confirmation stating the session shell/process will end, only committed work is landed, and the entire worktree, including ignored local files, is removed after a successful land.

- [x] **Step 6: Run the focused preflight tests**

Run: `cd apps/cockpit && bun test tests/live-land.test.ts --max-concurrency=1`

Expected: dirty, cancel, and idle cases pass.

### Task 4: Carry explicit authorization through both evidence outcomes

**Files:**
- Modify: `apps/cockpit/src/ui/ProjectView.tsx`
- Modify: `apps/cockpit/src/lib/land-actions.ts`
- Test: `apps/cockpit/tests/land-actions.test.ts`, `apps/cockpit/tests/live-land.test.ts`.

- [x] **Step 1: Add a failing test for ready evidence**

After the person confirms stop-and-land, verify the land callback receives the live-stop authorization and the session lands once.

- [x] **Step 2: Add a failing test for unknown evidence**

Verify the UI still asks “Land anyway” for unknown evidence. Declining it must not stop the shell; accepting it must pass both the unknown-evidence choice and the separately approved live-stop choice.

- [x] **Step 3: Add a failing test for blocked evidence and RPC errors**

Verify a blocked session never calls the RPC, and a `SESSION_STILL_LIVE` or changed-status error is shown without an automatic retry using stronger flags.

- [x] **Step 4: Pass force only after the session-specific confirmation**

Wire `landDeps()` to accept the explicit live-stop boolean and pass it to `api.landSession(name, forceLive)`. Carry it through both the first evidence check and the post-unknown-confirmation attempt. Leave every other call site at the default `false`.

- [x] **Step 5: Run focused land tests**

Run: `cd apps/cockpit && bun test tests/land-actions.test.ts tests/live-land.test.ts --max-concurrency=1`

Expected: no test other than the explicitly confirmed running-session path receives `force: true`.

### Task 4a: Recheck the live worktree at the daemon boundary

**Files:**
- Modify: `src/daemon/methods.ts`
- Test: `tests/daemon/methods-session.test.ts`

- [x] Add a failing RPC test proving dirty work is refused before the live shell is stopped.
- [x] Check git status before shell shutdown; unreadable status fails closed.
- [x] Check status again after shell shutdown and retain the stopped worktree if a write arrived during shutdown.
- [x] Run the focused daemon session test.

### Task 5: Verify the app gates and live flow

**Files:**
- Create: `docs/superpowers/specs/2026-10-11-cockpit-live-session-land-known-limitations.md`
- Update: `docs/superpowers/specs/2026-10-11-website-v2-known-limitations.md` (mark the live-session issue as fixed and point to the new limitation record)
- Update: `docs/superpowers/specs/2026-08-14-known-limitations-digest.md`
- Update: `docs/PROGRESS.md` after completion.

- [x] **Step 1: Run root typecheck**

Run: `bun run typecheck`

Expected: pass after the shared `SessionDiff` type change.

- [x] **Step 2: Run the root test suite sequentially**

Run: `bun test --max-concurrency=1`

Expected: pass in an environment that permits PTY and socket tests; report environmental restrictions accurately.

- [x] **Step 3: Build source binaries**

Run: `bun run build`

Expected: compiled `dist/cw` and `dist/cwd` binaries succeed after the `src/domain/session-diff.ts` contract change.

- [x] **Step 4: Run the Cockpit test suite**

Run: `cd apps/cockpit && bun test --max-concurrency=1`

Expected: pass.

- [x] **Step 5: Build Cockpit**

Run: `cd apps/cockpit && bun run build`

Expected: typecheck and Vite bundle pass.

- [x] **Step 6: Verify the user-visible flow on a scratch project**

Run the Cockpit with a scratch HOME and repository. Scratch smoke confirmed dirty work stays running, Cancel leaves the shell alive, clean live work asks before stopping and warns about ignored files, and successful land updates history/removes the row. Unit tests cover unknown convergence evidence and blocked/unknown statuses; no real project or user session was used.

- [x] **Step 7: Close the recorded limitation**

Update this feature's limitation record and digest only after the running-session UI flow works. Refresh `docs/PROGRESS.md` to describe the shipped behavior and current commit.

**Commit:** `fix(cockpit): confirm before stopping and landing a live session`
