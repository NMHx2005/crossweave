# Rail and status polish — known limitations

Four small fixes found while measuring the earlier 2026-09-30 features on the running app.

## What changed

- **A finished turn leaves no circle behind once looked at, and a quiet shell draws none** (`glyphState`): the ✓ beside the name is
  the one "finished, check it" mark and it goes when the session is opened. A turning ring while an agent works, amber when it asks,
  red on failure, a hollow ring for a closed shell are unchanged.
- **The rail keeps the newest answer** (`createLoadGate`): every `tui.invalidate` starts a load and loads are not serialised, so an older
  slower one could finish last and put back a list without a session created a moment earlier. A result is now applied only if no later-started
  load has already been applied.
- **Typing is not work** (`ActivityTracker.input(id, data)`): output arriving within 150 ms of a keystroke that is not Enter is the
  echo of that keystroke and does not make a plain shell look busy.
- **Landing asks when the last tests failed** (`landCheckWarning`): a fresh ✗ or a run in progress asks "Land anyway?"; a verdict the work
  has moved past, or a session never checked, says nothing.
- The row shows what a session said with `cw notify` (until its next keystroke) in place of the agent's latest words; the user's own note
  still wins.

## Limitations

- **The echo window is a heuristic.** A program that prints within 150 ms of a keystroke without Enter (a shell's autosuggestion, a
  full-screen program reacting to a key) is treated as echo; a program that does real work in response to a bare keypress is not
  counted as working until it outputs later than that. Input with no data (older callers) keeps the old rule.
- **The load gate drops an older answer even if it carried something the newer one lacks** (e.g. a field that only it had); the loads read the
  same daemon state, so in practice the newer one is a superset.
- **The land warning is advice, not a gate**: "Land anyway" always works, and a session that was never checked is never questioned.
- The rail's `cw notify` text is replaced by the agent's latest words after the next keystroke in that session.

## The random test failure, found and closed

A full run failed now and then in a test that had nothing to do with it ("Cannot use a closed database" from `TerminalRegistry.flush`).
Repeating the whole suite showed why: a registry's 30-second flush timer outlived a test that closed its database and fired during another
test. The timer callback now never throws (and logs once that it could not write), whatever state the database is in — a callback with no
caller has nobody to handle an error. Regression tests in `tests/daemon/terminal-persist.test.ts`. Three repeated runs by hand were
clean while the same suite failed in the background gate, so a green run is not proof that a flake is gone; the unit test is.
