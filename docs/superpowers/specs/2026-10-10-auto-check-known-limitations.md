# Auto-check — known limitations

Spec: `2026-10-10-auto-check-design.md` (with its amendments). Plan: `docs/superpowers/plans/2026-10-10-auto-check.md` (with the amendments
from its adversarial review).

## What shipped

With **Settings → Checks → Run checks when an agent finishes a turn** on (`checks.autoRun` in `~/.crossweave/settings.json`, **off by default**), the
daemon runs the project's trusted `converge.testCommand` in a session's worktree when a recognised agent ends a turn that changed files; the rail's
chip turns `tests…` and then `✓`/`✗` without anyone pressing **Run checks**. After a failure, the row menu offers **Send test failure to shell**, which pastes
the verdict and the end of the output into the shell — **never pressing Enter**. No schema change (still v18), no new dependency.

- A session is *owed* a run when a turn ends having changed (or possibly changed: a failed checkpoint) its tree. The run starts at a turn end where the
  session is **not asking** (`rang` — a permission prompt or a bell is not a finished turn), even if that last turn changed nothing. **One automatic run at a
  time**, daemon-wide; a run that has to wait, or whose session already has a check going, starts when any check finishes. A run is dropped silently when
  nothing is configured, trusted, or running, and a slot that never reports back is released after 15 minutes.
- Sessions without a checkpoint (the shared project folder, a plain folder) and plain shells are never auto-checked: there is no way to tell a chat-only
  turn from an editing one there.
- `session.check` and the automatic path share one function (`startCheck`): the same trust gate (`cw config trust`), worktree check, environment (`CW_CHECK=1`
  and the session's leases) and error codes.
- The pasted failure is the verdict line plus the tail (≤ 2000 characters), after **redacting tokens**, removing ANSI/OSC/DCS sequences and progress-bar
  rewrites, and stripping invisible characters (Unicode tag block, zero-width, bidi). Delivery is the shared `deliverText` (an agent gets one bracketed
  paste; a plain or closed shell is refused). Diff-comment quotes now also mark the Unicode tag block.

Verified: unit tests for the decision, the trigger and the formatter; `tests/daemon/methods-check-auto.test.ts` through the real status sweep and a fake
agent (an edit → a `fail` verdict with no `session.check` call; a second turn that edits nothing starts no run; setting off and an untrusted command start
nothing, each with a positive control); and live on the real cockpit with `apps/cockpit/scripts/auto-check-check.ts` (7 checks: no verdict before the turn,
`✗ tests` on the rail by itself, the menu item, the toast, and the bytes at a raw-mode fake agent are one bracketed paste with the failure and no `\r`),
plus a look at the Settings page (the row, its description, the switch reading the saved value).

## Limitations

- **This lets an agent's own work cause a test run.** The command executes code the agent has just written, **outside the agent's sandbox**, with the daemon's
  whole environment and network. A sandboxed agent that cannot reach the daemon socket to run `cw check` can get a run by writing a test and ending its turn.
  The command itself cannot be changed (it comes from the repository config behind the trust hash). The setting is **global**: it arms every project whose
  `testCommand` was ever trusted for `land` or a manual check.
- **Turn ends are inferred from the screen**, so a pause can end a "turn" twice. Bounded by the checkpoint dedupe, the owed-run model and the one-run-at-a-time
  rule, not eliminated.
- **Change detection compares with the newest checkpoint of any kind.** It **misses** a run when a manual checkpoint (the person's, or the agent's own
  `cw checkpoint`) was taken mid-turn, when edits predate a late-paid `start`, and when only ignored files changed. It **runs needlessly** when a long
  suite's own untracked output (coverage, junit) lands during the next turn, or when the person edited between turns while `start` was dropped. The very first
  checkpoint of a session always reads as "changed". A checkpoint refused by the 50 MB guard reads as `unknown` on every turn, so that session is checked every turn.
- **An automatic run races the agent's next turn** in the same worktree (the verdict then shows stale), and **manual runs are not counted** in the
  one-at-a-time rule, so a manual and an automatic run can overlap in different sessions.
- **It tests the session's own worktree, not the merged result**; one command per project (no lint/typecheck split); **no notification** when an automatic run
  fails — look at the chip.
- **The paste can go to the wrong kind of shell** if an agent exited less than a sweep before the click: the session list is re-read first, which narrows
  the window but cannot close it (diff comments do not re-read at all). A plain shell that receives a multi-line paste would run it line by line.
- **Prompt injection is not solved, only made visible**: a test's output is untrusted text, quoted into the shell without Enter. The person reads it first,
  but an agent that reads the paste reads it too. Tokens are redacted by pattern (`redactSecrets`), so an unusual secret shape can still get through.
- **A daemon older than the cockpit** ignores the setting until it restarts (the cockpit's settings guard keeps the saved value); the daemon reads the
  file at each turn end, so toggling the setting needs no restart once the daemon is new enough.
- **Restricted environments:** two cockpit tests that need a pty / unix socket still fail inside a sandbox, as before; they pass outside it.

## Ideas not built

A desktop notification when an automatic run fails, a per-project switch, a minimum interval between runs, counting manual runs in the one-at-a-time rule,
separate lint / typecheck commands, sending the failure automatically (never with Enter), and the same re-read for diff comments. Feature 4 of the series
(sensitive-file flags in a session's diff) is a separate milestone.
