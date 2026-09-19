# Orphan sweep scope — known limitations

**Date:** 2026-09-19
**Scope:** what the boot-time orphan sweep may and may not delete, and what the fix
does not cover.

## What was wrong

`sweepOrphans` reclaimed every worktree `git worktree list` reported that no session
row claimed. "No session row claims it" is not the same as "crossweave created it":
worktrees a developer made by hand (`.worktrees/feat-x`, a second checkout for a
long-running branch) have no session row either, so the sweep deleted them too —
uncommitted work included.

The blast radius was worse than "the daemon does this on boot": `buildMethods` runs
the sweep, and `tests/daemon/methods-converge.test.ts` pointed its workspace at
`process.cwd()`. Running that suite from a repo root aimed a destructive operation at
the repo it was run from. That is how this was found — it destroyed the worktree the
Cockpit daily-driver work was being done in.

## What the fix does

`isCrossweaveWorktree` (in `src/isolation/worktree.ts`) decides ownership, and
`sweepOrphans` skips anything it does not own. crossweave creates worktrees in exactly
two places, both under `.crossweave/` — a session's at `.crossweave/worktrees/<id>`,
the integration scratch at `.crossweave/integration` — so `.crossweave/` is the whole
of what crossweave owns.

The converge tests now build a throwaway `makeGitFixture` repo instead of borrowing the
developer's checkout.

## Limitations this does not close

- **A user worktree placed *inside* `.crossweave/` is still crossweave's to delete.**
  Ownership is a path check, not a record of who ran `git worktree add`. Nothing
  recommends putting work there, and `.crossweave/` is crossweave's own directory, but
  the check cannot tell the difference.
- **Ownership is not re-verified against git's own registration.** A worktree moved into
  `.crossweave/` by hand after creation reads as ours.
- **`isCrossweaveWorktree` fails closed on an unresolvable `.crossweave/`.** It reports
  "not ours", so such a worktree is skipped rather than reclaimed. That leaves garbage
  behind in a case that should not arise (the directory exists in any workspace with
  sessions), and leaking a directory is the safe direction to fail.
- **The grace window is unchanged.** `ORPHAN_GRACE_MS` still exists to cover the window
  between `createWorktree` returning and `sessions.insert` committing; this fix does not
  touch that race.
- **A developer worktree is never garbage-collected by crossweave at all**, by design —
  so it is also never cleaned up when it is genuinely abandoned. That is the user's
  call, not the daemon's.
