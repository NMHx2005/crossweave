# Session hook workspace resolution

## Problem

Commands started inside a Crossweave session run with `cwd` set to that session's linked worktree. `git rev-parse --show-toplevel` therefore returns the worktree path, and `cw` starts or connects to a daemon rooted there. That daemon does not own the session row, so a hook command such as `cw notify` receives `SESSION_NOT_FOUND` even though `CW_SESSION_ID` is present.

The live reproduction used a disposable project: the session shell wrote its `CW_SESSION_ID` to a scratch file, then `cw notify` from that worktree returned `SESSION_NOT_FOUND`. The owning daemon remained healthy.

## Design

The daemon will set `CW_WORKSPACE_ROOT` in every session shell and extra terminal pane it starts. The value is the absolute repository root already known by that daemon and is applied after client, launcher, and lease environment values so those sources cannot replace it. The name is added to the reserved environment list.

The CLI context resolver will use `CW_WORKSPACE_ROOT` when both it and `CW_SESSION_ID` are present **and the current directory is still inside that repository's `.crossweave/` worktrees** (review 2026-10-08: the variable is stale after a `cd` into another repository, and honouring it there silently sent `cw` to the wrong daemon). Outside those worktrees the current directory wins. It validates the root through the existing Git root resolver before connecting. With no session identity, commands keep resolving from the current directory as before. `cw daemon stop` and `cw tui` use the same resolver, so one shell never talks to two daemons. This keeps ordinary terminals and manually opened worktrees unchanged while routing session commands, including hooks, back to their owning daemon.

No database or RPC schema change is needed. Existing sessions are stopped when their daemon is restarted; their next start receives the new environment value.

## Verification

- A unit test creates a linked worktree and proves a session context resolves to the owning repository while a normal context resolves to the current worktree.
- The daemon runtime test asserts that a started shell receives the exact workspace root and its own session id.
- A live run from a disposable Cockpit session invokes `cw notify` and verifies the owning daemon exposes the resulting signal.
- The existing hook configuration tests continue to cover safe config editing and removal.

## Limits

The variable is a same-user process hint, not an authentication mechanism. The daemon still validates the session id and workspace when handling the RPC. Old shells without `CW_WORKSPACE_ROOT` need to be restarted before their commands can route through the owning daemon.
