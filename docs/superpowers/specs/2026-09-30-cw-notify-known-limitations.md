# `cw notify` — known limitations

Spec: `2026-09-30-agent-workflow-features-design.md` §1. Plan: `docs/superpowers/plans/2026-09-30-agent-workflow-features.md` phase 1.

## What shipped

`cw notify "<message>" [--kind done|ask] [--session <name|id>]` (session defaults to `$CW_SESSION_ID`) tells the daemon
the session itself is done or needs an answer. `session.notify` marks the activity tracker (`done` = finished, no
ring; `ask` = rings, so amber), stores `signal {kind, message, at}` until the next keystroke in that session, and
broadcasts `tui.invalidate`. The cockpit shows the existing marks (✓ for a new done signal until the session is
opened; amber for ask), puts the message in the row tooltip and in the desktop notification when the app is away.
Measured on the real app with `apps/cockpit/scripts/notify-check.ts` (8 checks).

## Wiring it to an agent

Anything that can run a command on an event can call it. For Claude Code, a `Stop` hook running `cw notify "Claude finished"`
(and a `Notification` hook running `cw notify --kind ask "Claude needs you"`) makes the rail exact instead of guessed.
`cw` must be on the session shell's `PATH`.

## Limitations

- **Unauthenticated by design**, like the command bridge: any process of the same user that can reach the daemon's
  socket can mark any session. The worst it can do is put a mark and one plain sentence (control characters
  stripped, at most 200 characters, over-long refused) on a row. Nothing it sends is ever run.
- The signal lives in the daemon's memory: a daemon restart forgets it (the session itself is gone then anyway).
- A signal is cleared by the next keystroke **in that session's own terminal**; typing in an extra terminal (split
  pane) does not clear it.
- `done` reaches the ✓ only when the person is away or looking at another session (the same rule as a screen-detected
  finish), and a window that was closed at that moment never sees the "just now" edge: a reload shows the row without ✓.
- No `info` kind (a notification with no state change) and no history of signals.
- A plain shell counts as *working* while it prints (its prompt, keystroke echo) for about 4 seconds; that is the
  existing output rule and is not changed here.
