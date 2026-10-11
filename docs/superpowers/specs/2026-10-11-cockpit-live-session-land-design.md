# Land a live session from Cockpit — design

## Problem

The Cockpit's single-session Land action calls `land.session` without the daemon's `force` option. The daemon refuses a running session with `SESSION_STILL_LIVE`; its trial scheduler classifies only running or idle sessions, so the UI may also need to resolve unknown convergence evidence. The CLI already supports `cw land ... --force`, which stops a running shell before landing.

## Goal and boundaries

Let a person deliberately stop and land a running session from Cockpit while preserving the current evidence, failed-test and sensitive-file confirmations. Do not change `cw land`, `Land all ready`, or treat an incomplete trial as safe. Do not automatically stop an agent or discard uncommitted session files.

## Chosen flow

Before any stop, fetch the session diff and inspect its `uncommitted` count. If it is nonzero, explain that the uncommitted work must be committed or handled first and leave the session running. If status cannot be read, fail closed: the current diff helper silently converts a `git status` failure to `0`, so change `SessionDiff.uncommitted` to `number | null` and keep `null` through the RPC/parser; do not treat it as clean. For a clean running session, ask one explicit “Stop and land” confirmation that names the session and says the shell/process ends, only committed work is landed, and the entire worktree is removed after success, including ignored local files. Cancel leaves the session untouched.

After the person confirms, use the existing land decision path and pass the daemon's `force: true` only for this explicitly confirmed live-session action. The daemon also checks the worktree status at the RPC boundary before stopping, because the shell can write while the confirmation is open; it checks again after the shell exits and retains the stopped worktree and branch if a late write appeared. Unknown status fails closed at both checks. If convergence is unknown, keep the existing separate “Land anyway” confirmation; both confirmations are required before stop-and-land on unknown evidence. A blocked session remains blocked. Existing check and sensitive-file warnings remain in place. If the daemon reports a new error or status changed during the prompt, show the error and do not retry with stronger flags automatically.

The `forceUnknown` UI option remains distinct from `force` at the RPC boundary. `Land all ready` stays unchanged and never gains a stop behavior.

## Acceptance

- Canceling the live-session confirmation does not stop the shell or mutate the base branch.
- A live session with uncommitted files is not stopped or landed; the person receives a clear instruction to commit or handle those files first.
- A late write before the RPC is refused while the shell is still running; a write during shell shutdown prevents land and preserves the stopped worktree and branch.
- If git cannot report uncommitted state, the UI fails closed and does not stop or land. A clean-state count is never inferred from a failed status command.
- The stop-and-land confirmation says that the entire worktree is deleted after success, including ignored local files.
- Confirming with zero uncommitted changes stops the shell and lands only after current convergence evidence permits or the person separately accepts unknown evidence.
- A blocked session never lands; a failed or stale check and sensitive-file warning retain their existing meanings.
- A plain idle session follows the existing one-click path.
- The CLI's `--force`, `--skip-check`, and `cw land all` contracts do not change.

## Relevant files

- `apps/cockpit/src/ui/ProjectView.tsx` — preflight, confirmations and action sequence.
- `apps/cockpit/src/lib/land-actions.ts` — pure evidence gate; unknown evidence and explicit live-stop authorization stay separate.
- `apps/cockpit/src/host/cockpit-api.ts` — typed wrapper already exposes `sessionDiff` and `landSession(id, force, projectRoot)`.
- `src/domain/session-diff.ts`, `tests/domain/session-diff.test.ts` — preserve an unavailable worktree status as `null`, not as a clean count.
- `apps/cockpit/src/lib/patch.ts`, `apps/cockpit/src/lib/compare.ts`, `apps/cockpit/src/ui/ChangesPane.tsx`, `apps/cockpit/src/ui/CompareView.tsx` — carry and present the nullable count without misreporting it as zero.
- `apps/cockpit/tests/land-actions.test.ts` — pure land selection contract.
- Cockpit component tests under `apps/cockpit/tests/` — confirmation/cancel/preflight interactions; use the existing harness after locating its ProjectView coverage.
- `src/daemon/methods.ts` — fail-closed uncommitted-status checks before and after a confirmed live stop; `src/convergence/land.ts` keeps its existing force behavior and `SESSION_STILL_LIVE` contract.
