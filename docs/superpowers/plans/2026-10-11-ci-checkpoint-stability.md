# CI Checkpoint Test Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` and complete each task in order. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Linux CI test gate stable and align it with the dedicated Cockpit test job, without weakening test contracts.

**Architecture:** The Linux job runs the engine and website tests with concurrency 1; the macOS job remains responsible for Cockpit tests and dependencies. Keep deterministic transition tests and the existing real-shell checkpoint and auto-check integration tests unchanged. Resolve the remote Linux timeout with diagnostics before deciding whether it is a code defect or a runner boundary.

**Tech Stack:** Bun 1.3.14, TypeScript, `bun:test`, PTY-backed daemon test fixtures, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-11-ci-checkpoint-stability-design.md`

## Global Constraints

- Bun is `>=1.3.13`; CI currently pins 1.3.14.
- Keep the test about observable checkpoint behavior, not logs or private implementation details.
- Never weaken a test to make it pass; preserve the plain-shell negative case.
- Root tests run sequentially with `bun test --max-concurrency=1` when resource load is high.
- PTY tests may need a real terminal allocator; validate sandbox failures against `main` before attributing them to a change.
- Do not introduce native dependencies.

---

### Task 1: Identify the CI failure mode

**Files:**
- Read: `.github/workflows/ci.yml`
- Read: `tests/daemon/methods-checkpoint-auto.test.ts`
- Read: `docs/HANDOFF-2026-10-11.md`
- Record outcome in: `docs/superpowers/specs/2026-10-11-ci-checkpoint-stability-design.md`

- [x] **Step 1: Inspect the latest failed run logs**

Read failed run `38111732784` and identify the exact test, assertion or timeout, elapsed time, and whether cleanup completed.

- [x] **Step 2: Compare the earlier failed runs**

Read runs `37851461440` and `37848936997`; record whether they fail in the same test or fail earlier in setup.

- [x] **Step 3: Match CI's runtime locally**

Record `bun --version` and run the focused test repeatedly with Bun 1.3.14 where available. Do not run the full suite concurrently with another gate.

- [x] **Step 4: Choose the smallest evidence-backed fix**

If the test misses an event because real elapsed time controls the assertion, control the status sweep or wait seam while preserving the production path under test. If the runner simply needs more time and the logs show the expected state progressing, adjust only the narrowest timeout and document why. If production checkpoint behavior stalls, fix that behavior and retain the end-to-end assertion.

**Expected:** A written cause, the same/unrelated classification for earlier failures, and a concrete fix selected before implementation begins.

**Finding from 2026-10-12:** comparison run `38111732784` on `main` reproduces the same four PTY timeouts and six Cockpit module errors. Concurrency 1 did not alter the timeouts, and Bun's positional filters did not exclude Cockpit. The cause predates the branch, but its Linux-specific boundary is still unknown; collect diagnostics before changing behavior or CI coverage.

### Task 2: Keep the regression contract strong

**Files:**
- Modify only when diagnosis requires it: `tests/daemon/methods-checkpoint-auto.test.ts`
- Modify only when diagnosis requires it: `src/daemon/checkpoint-trigger.ts`
- Test: `tests/daemon/checkpoint-trigger.test.ts`

- [x] **Step 1: Preserve both positive and negative behavior**

Keep an assertion that a recognised agent's edit appears in the automatic `turn` checkpoint and that the preceding checkpoint does not contain it. Keep the plain-shell case asserting no automatic checkpoints.

- [x] **Step 2: Make only the diagnosed timing change**

Use a deterministic sweep/event seam if that is the cause. Avoid arbitrary sleeps, silent retries, and assertion removal. If adjusting a timeout, tie it to observed runner duration and leave sufficient time for cleanup.

- [x] **Step 3: Run the focused test repeatedly**

Run: `bun test tests/daemon/methods-checkpoint-auto.test.ts --max-concurrency=1`

Expected: repeated passes with no test-level or helper-level timeout.

- [x] **Step 4: Run the deterministic transition tests**

Run: `bun test tests/daemon/checkpoint-trigger.test.ts --max-concurrency=1`

Expected: all state-transition cases pass.

### Task 3: Align and close the CI gate

**Files:**
- Verify: `.github/workflows/ci.yml`
- Update if needed: `docs/PROGRESS.md`, `docs/HANDOFF-2026-10-11.md`
- Update if a limitation remains: a dated `*-known-limitations.md` plus `docs/superpowers/specs/2026-08-14-known-limitations-digest.md`

- [x] **Step 1: Run typecheck**

Run: `bun run typecheck`

Expected: pass.

- [x] **Step 2: Run the complete local suite sequentially**

Run: `bun test --max-concurrency=1`

Expected: pass, with PTY tests run in an environment that permits allocation.

- [x] **Step 3: Build when production source changed**

If the diagnosis changed any file under `src/`, run: `bun run build`

Expected: `dist/cw` and `dist/cwd` compile. Skip this gate if the final fix only changes tests or workflow configuration.

- [ ] **Step 4: Set the Linux job's suite boundary and concurrency**

Use Bun's `--path-ignore-patterns` to exclude `apps/cockpit/**`; positional arguments such as `tests website/tests` are substring filters and do not constrain discovery. Keep test concurrency at 1. Diagnose the four PTY timeouts before deciding where those tests belong.

The Cockpit suite is already run with its dependencies in the macOS job. The Linux
job must not discover those tests without their platform-specific dependencies.

### Task 4: Diagnose the Linux PTY failures before adjusting coverage

**Files:**
- Diagnostic-only changes if needed: `tests/daemon/methods-checkpoint-auto.test.ts`, `tests/daemon/methods-check-auto.test.ts`
- Read: `src/daemon/session-status.ts`, `src/daemon/checkpoint-trigger.ts`, `src/daemon/methods.ts`

- [x] **Step 1: On timeout, report observable session state**

Include activity, detected agent, checkpoint rows, process ancestry and the session shell's descendants in the test error. Do not emit diagnostics on successful runs.

- [x] **Step 2: Reproduce the focused cases on the Linux runner**

The full Linux job in run `38231615436` found all four PTY failures again. Diagnostics show the fake `claude` is a descendant of the session shell and the daemon detects it, while the session remains `working` with only the start checkpoint. Linux CI uses `/bin/sh` → `dash`: `printf '\\x1b…'` prints a literal backslash sequence, so the fake agent never sends its final ANSI clear-screen sequence. A direct `dash` check produced `5c 78 31 62` for `\\x1b` and `1b` for `\\033`. The fixtures now use portable `\\033` escapes. The diagnostic run `38232700603` showed the fake agent had reached `sleep 60` after its prompt, confirming the script had completed its busy loop, and the fixture-copy `ENOENT` did not recur.

- [x] **Step 3: Fix the diagnosed cause while preserving the contract**

Changed both fake agent scripts to emit portable POSIX octal ANSI escapes. All five focused checkpoint/auto-check PTY tests pass locally, including the assertions that a completed turn produces a `turn` checkpoint and that trusted checks run only under their existing conditions.

- [x] **Step 4: Verify targeted cases and full CI**

Focused tests pass locally (5/5); `bun run typecheck` passes; the serial root suite passes (2,362/2,362). CI run `38233229200` passes both jobs on `aed0d29`: the Linux root suite and the macOS Cockpit build/tests.

- [x] **Step 5: Run the CI workflow on the fix**

GitHub Actions run `38233229200` completed successfully: `test` (Linux root suite) and `cockpit` (macOS build and tests) both pass.

- [x] **Step 6: Refresh project status**

Record the root cause, fix commit, local gate results and CI run URL in the handoff/progress record. Remove the active CI-red item only after the remote run passes.

**Remote CI run:** [38233229200](https://github.com/NMHx2005/crossweave/actions/runs/38233229200) — both jobs pass on `aed0d29`.

**Fix commit:** `test: use portable ANSI escapes in PTY fixtures` (`aed0d29`). Root cause, local gates and remote CI are complete.
