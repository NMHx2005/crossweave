# Daemon lifecycle — Known Limitations

**Date:** 2026-09-29
**Spec:** `docs/superpowers/specs/2026-09-29-daemon-lifecycle-design.md`
**Plan:** `docs/superpowers/plans/2026-09-29-daemon-lifecycle.md`

## What is fixed

- **A daemon that fails to start exits.** `src/daemon/main.ts` attaches a `.catch` to
  `main()`: `DAEMON_ALREADY_RUNNING` exits `DAEMON_EXIT_ALREADY_RUNNING` (75), any other
  startup failure exits 1. Previously the rejection reached the module's
  `unhandledRejection` handler, which only logs, so the process lingered forever —
  **359 live daemon processes** were found on the reporting machine, and
  `connectOrStart` spawns one more on every failed connect.
- **Losing the bind race is not a start failure.** `connectOrStart` treats exit 75 as
  "keep waiting for the daemon that owns the socket" (it is the winner), and for any
  other early exit tries one last connect before failing at once.
- **The daemon has a log.** The client redirects the daemon's stdout/stderr to
  `.crossweave/daemon.log` (0600, truncated at 1 MB per spawn). A socket-loss shutdown
  now records `socket removed or replaced — shutting down, hanging up N session(s)`,
  and `daemon.shutdown` records the same count. Running `cwd` by hand still prints to
  the terminal.

## Gaps (unchanged by this fix)

- **Sessions still die with the daemon.** A session's shell is a child of the daemon in
  a pty; closing the master SIGHUPs it. There is no supervisor and no session
  persistence across a daemon restart: `reconcile()` reports the rows `idle`/`dead` on
  the next start and the shells are gone. Making them survive is a supervisor design,
  not a patch.
- **The watchdog still self-destructs on a lost socket** (`src/daemon/server.ts`,
  ≤5 s). It is a deliberate bound on orphaned daemons
  (`2026-09-26-audit-fixes-known-limitations.md`) and is only now *visible*. It fires
  when the socket file is deleted or replaced — including when `.crossweave/` is
  removed. `.crossweave/` is gitignored, so **`git clean -xdf` in a project with
  running sessions takes every session down**; use `git clean -df` (no `-x`) instead.
- **A network-timing window remains** in `connectOrStart`'s exit handling: between the
  child's exit and the last connect attempt a winner could still be binding. The
  window is small (the loser only exits after connecting to the winner), but it is
  real.
- **The log is per-project and unrotated** apart from the 1 MB truncate at spawn; a
  daemon started by hand (not by a client) writes to its terminal, not the file.
