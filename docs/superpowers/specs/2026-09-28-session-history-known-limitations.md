# Session history — Known Limitations

**Date:** 2026-09-28
**Plan:** `../plans/2026-09-28-parallel-agents-backlog.md` (Part A)

## What is built

- `session_history`: a durable table, NOT a foreign key to `session` (the whole point
  is to outlive that row) — a snapshot of `name`, `agentKind`, `branch`, `finalStatus`
  (`landed`/`dead`), `createdAt`, `endedAt`, `tokenSpent`, `costSpentUsd`, `note`.
- Recorded at the three places a session row is ever deleted: `SessionManager.remove()`
  (`cw session rm`), `SessionManager.kill({removeWorktree: true})`
  (`cw session kill --rm-worktree`), and `gc.ts`'s `reclaimEnded` (`cw gc`) — always
  just before the `DELETE`, never after (a crash between the two loses the record,
  not the session).
- `session.history` RPC (`{workspaceId, limit?}` → newest-`endedAt`-first, default 50).
- `cw session history` (`NAME STATUS BRANCH ENDED TOKENS`, `no history` when empty).
- Cockpit: `⌘⇧H` / Session → Session History… opens a read-only table
  (`SessionHistoryDialog.tsx`), backed by `session.history` through the same
  per-window/per-project API layer every other RPC uses.

## Gaps

- **`kill` without `--rm-worktree` records nothing.** The session is left `dead` with
  its row intact precisely so it can still be landed or removed later — history is
  written once, at actual deletion, not at every status change. A `dead` session
  killed months ago and never cleaned up has no history entry until someone finally
  removes it.
- **No retention limit.** `session_history` grows forever; nothing prunes it. For a
  personal, single-workspace use this is a rounding error, but it is unbounded.
- **Not searchable/filterable beyond `limit`.** No date range, no status filter, no
  text search on name/branch. `cw session history` and the cockpit dialog both show
  the newest N and nothing more.
- **The cockpit dialog is untested visually.** `apps/cockpit`'s test suite is
  logic-only (parsers, no component-render tests, matching its existing convention) —
  `parseSessionHistory` has full unit coverage and the app builds, but the dialog was
  not opened in a running app to confirm layout/interaction; Electron's own window
  cannot be screenshotted from this environment.
- **`cw session history` and the cockpit dialog's end-to-end paths are covered by
  tests that require a real unix socket / pty**, both blocked in this sandbox
  (documented trap in `AGENTS.md`) — confirmed instead by running the pre-existing
  suite of the same shape (`session list`, etc.) and finding it fails identically on
  unmodified `main`, i.e. environmental, not a regression.
