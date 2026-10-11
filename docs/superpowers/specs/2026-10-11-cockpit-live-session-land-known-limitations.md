# Cockpit live-session Land — known limitations

## What changed

Cockpit now preflights a session's uncommitted files before it offers to stop and land a live shell. Dirty or unreadable status leaves the session running. For a clean live session, one session-specific confirmation explains that the shell and its processes end, committed work alone is landed, and the whole worktree—including ignored local files—is removed only after success. The existing convergence, check and sensitive-file decisions still apply. Unknown convergence evidence requires a separate “Land anyway” choice.

The daemon repeats the uncommitted-status check at the RPC boundary before stopping the shell, because the shell remains active while the confirmation is open. It checks again after shutdown and retains the stopped worktree and branch if a write arrived during the stop. `SessionDiff.uncommitted` is nullable, and the Changes, Compare and Debug surfaces keep unreadable status distinct from a clean count.

## Still open

- The live flow was exercised in a scratch macOS Electron app: dirty work did not stop the shell; Cancel kept it running; confirming a clean live session landed it and removed its rail row. Pure tests cover unknown evidence, blocked evidence, and status-unknown handling. No real project or user session was used.
- A write racing with process shutdown can leave the shell stopped while preserving the worktree and branch; the person must inspect or commit that work and land again. The daemon prevents the worktree from being deleted in that case.
- The new daemon refusal codes are visible through the existing error/toast path. Older Cockpit builds do not have this UI flow; upgrading the app is required.
- This implementation is local to `codex/post-release-completion`. The currently published release does not include it until the branch is integrated and released.
