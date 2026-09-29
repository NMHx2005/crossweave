# Daemon lifecycle — design

**Date:** 2026-09-29
**Branch:** `feat/session-hooks` (follow-up fix)
**Trigger:** "Some sessions I open in the app die on their own; I switch to another
project, come back, and they are all dead."

## What actually happens

A session is a shell the per-project daemon spawned in a pty
(`src/adapters/pty.ts` → `spawnInShell`). The service contract is one process per
project: the daemon (`cwd`) owns `.crossweave/state.db`, its unix socket, and every
session's pty. The CLI, the TUI and the cockpit are clients.

Consequences that shape this fix:

- **A session's shell is a child of the daemon.** When the daemon's process ends,
  the pty master closes and the kernel SIGHUPs the shell. Every session in that
  project dies at once — proven in this investigation by deleting the socket and
  watching both the daemon and its shell exit. Recorded since M0:
  `docs/superpowers/specs/2026-08-10-m0-known-limitations.md` ("Every pty *is* reaped
  when the daemon dies").
- **The daemon exits on purpose when its socket file is gone or replaced**
  (`src/daemon/server.ts` watchdog, ≤5 s; `src/daemon/main.ts` `onSocketLost`). `.crossweave/`
  is gitignored, so a `git clean -xdf`, a cleanup script, or a concurrent daemon that
  wins the bind race all take the socket out from under a running daemon and its
  sessions.
- **On the next connect** `connectOrStart` spawns a fresh daemon; `reconcile()`
  (`src/domain/reconciliation.ts`) then reports those sessions `idle`/`dead`, so the
  rail shows them closed. That is the "come back and they're all dead".

So the user-visible bug is "the daemon went away". The fixes below are what we can
make correct without a supervisor (a daemon that survives its socket, or restores
sessions across a restart, is a separate design).

## Defects fixed here

1. **A daemon that fails to start never exits.** `src/daemon/main.ts` calls
   `void main()` with no `.catch`, and the module registers an `unhandledRejection`
   handler that only logs. A daemon that loses the bind race
   (`DAEMON_ALREADY_RUNNING`) or cannot open its database therefore lingers forever.
   `connectOrStart` spawns a daemon whenever a connect fails, so these accumulate:
   **359 live daemon processes** were found on the reporting machine (142 for one
   worktree, 46 for the repo itself). Reproduced: a second daemon for a busy socket
   stayed alive indefinitely.

2. **The reason a daemon stopped is thrown away.** `connectOrStart` spawns the daemon
   with `stdio: 'ignore'`, so the daemon's own line
   `daemon socket removed or replaced — shutting down` and any startup error go to
   `/dev/null`. There is nothing to read after sessions die.

3. **Losing the bind race is reported as a start failure.** Once (1) exits on failure,
   the client must not mistake "another daemon owns the socket" for "this daemon could
   not start". The daemon gets a distinct exit code for that case and the client keeps
   polling for the winner.

## Decisions

- **Exit codes:** `DAEMON_EXIT_ALREADY_RUNNING = 75` for "another daemon owns the
  socket" (shared via `src/core/exit-codes.ts`); every other startup failure exits 1.
  The client treats 75 as "keep waiting", anything else as final.
- **Log:** the client redirects the daemon's stdout/stderr to
  `.crossweave/daemon.log` (0600, truncated at 1 MB per spawn). One timestamped line
  per lifecycle event, written by `src/core/log.ts` `daemonLog()`. Running `cwd` by
  hand still prints to the terminal.
- **The watchdog keeps its behaviour.** It is a deliberate decision
  (`2026-09-26-audit-fixes-known-limitations.md`) that bounds orphaned daemons; not
  exiting would bring back the "eleven daemons on one dev machine" problem. What
  changes is that the shutdown is now *visible* and says how many sessions it took
  down. Making sessions survive a lost socket is a supervisor design, tracked in the
  known-limitations doc.

## Non-goals

- A supervisor / session persistence across daemon restarts.
- Making `.crossweave` survive `git clean -xdf` (it is ignored on purpose; the fix is
  to not clean it while sessions run).
