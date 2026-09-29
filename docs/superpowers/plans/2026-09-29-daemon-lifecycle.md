# Plan — daemon lifecycle fixes (2026-09-29)

**Source:** `docs/superpowers/specs/2026-09-29-daemon-lifecycle-design.md`
**Tier:** Small–Medium — client/daemon contract (exit code), 4 source files + tests.
**Branch:** follow-up on `feat/session-hooks`.

## Tasks

1. `src/core/exit-codes.ts` — `DAEMON_EXIT_ALREADY_RUNNING = 75`.
   `src/core/log.ts` — `daemonLog(message)`: one timestamped line to stderr.
2. `src/daemon/main.ts` — attach a `.catch` to `main()`: exit 75 on
   `DAEMON_ALREADY_RUNNING`, exit 1 on any other startup failure; log SIGINT/SIGTERM
   and the socket-lost shutdown.
3. `src/client/rpc-client.ts` — spawn the daemon with stdout/stderr redirected to
   `.crossweave/daemon.log` (0600, truncated at 1 MB); treat exit 75 as "keep polling";
   on any other early exit, try one last connect then fail at once.
4. `src/daemon/methods.ts` — `daemon.shutdown` logs that it is stopping every session.
5. Tests:
   - `tests/daemon/main.test.ts` (new): the entry exits non-zero for a non-repository
     cwd, and exits `DAEMON_EXIT_ALREADY_RUNNING` when the socket is already owned.
   - `tests/client/rpc-client.test.ts`: exit 75 keeps the client waiting, then it
     connects once a daemon appears; the spawned daemon writes `daemon.log`.
6. Docs: known-limitations + digest line.

## Gate

`bun run typecheck` · `bun test --max-concurrency=1` · `bun run build` (sequentially).
