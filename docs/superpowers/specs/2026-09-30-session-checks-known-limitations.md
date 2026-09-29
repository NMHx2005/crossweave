# Session checks — known limitations

Spec: `2026-09-30-agent-workflow-features-design.md` §2. Plan: `docs/superpowers/plans/2026-09-30-agent-workflow-features.md` phase 2.

## What shipped

`cw check [session]` and the rail's **Run checks** (row menu, or the chip) run the project's `converge.testCommand` in that
session's own worktree and show the verdict on the row: `tests…`, `✓ tests`, `✗ tests` (words as well as colour, dim when
stale). `cw check` waits, prints one line and the end of the output on failure, and exits 1 on failure. The command is
run only after the same trust gate `land` uses (`cw config trust`): none configured is `CHECK_NOT_CONFIGURED`, an
untrusted one `CHECK_UNTRUSTED`, and nothing runs. One run per session at a time (`CHECK_RUNNING`), a 10-minute
timeout (exit 124), stdin closed, output kept to its last 8000 characters (2000 sent to clients on failure).
Measured on the real app with `apps/cockpit/scripts/checks-check.ts` (8 checks).

## Limitations

- **The result lives in the daemon's memory.** A restart forgets every verdict.
- **A verdict is pinned to the session's git counts** (changed files, commits ahead) as the run ended, and shows *stale*
  when they change or when the session's terminal was active more than 2 s after the run ended. It errs toward stale.
  Two things it cannot see: an edit that keeps both counts the same while nothing runs in the session's terminal, and any
  change while no client is redrawing (the rail re-reads a session when something happens, not on a timer).
- **It tests the session's own worktree, not the merged result.** `land` runs the command on the integration
  worktree (base + this branch); a session that passes alone can still fail after merging. The chip says "tests", not "will land".
- **Lease environment is not injected.** The command runs with the daemon's environment plus `CW_SESSION_ID`,
  `CW_SESSION_NAME` and `CW_CHECK=1`; the session's port/db/cache leases are not applied, so a test that binds a fixed port
  can collide with the session's dev server.
- **A timeout kills the `sh` only.** A test runner that forked children can leave them running after the 10 minutes.
- A plain project folder (no git) has no counts, so a verdict there can only go stale through terminal activity.
- One command per project: there is no per-session or per-path command, and no `lint`/`typecheck` split.
