# Session setup — exit code tracking — Known Limitations

**Date:** 2026-09-28
**Plan:** `../plans/2026-09-28-parallel-agents-backlog.md` (Part B)
**Closes a gap from** `2026-09-28-session-hooks-known-limitations.md`: "the daemon types
the hook and never learns its exit code... the rail can show `pending` before it runs,
but never `failed`."

## What is built

- `wrapWithSentinel(command)`: wraps `hooks.sessionSetup` in a `( )` subshell that
  captures its real exit code and writes it out as an OSC (Operating System Command)
  escape sequence, `ESC ] 6961 ; <code> BEL`. OSC sequences are consumed by every real
  terminal (xterm, iTerm2, Terminal.app, the cockpit's xterm.js pane) without being
  printed — nothing strips it from the pty stream, the terminal already hides it. A
  subshell, not a `{ }` group: a hook whose own command calls `exit` (a script ending
  `exit $?`) would otherwise terminate the user's whole login shell.
- `SetupExitWatcher` (fanned into `SessionRuntime`'s observer alongside `ActivityTracker`
  via a new `combineObservers`) scans every session's output for the sentinel — a
  bounded per-session buffer (512 bytes) survives it landing split across chunks — and
  records the code via `SessionSetupRepo.recordExitCode`.
- `session_setup.exit_code` (migration, nullable): null until observed.
- `session.list`'s `setup` field: `'pending'` (unchanged) when not yet typed;
  **`'failed'` (new)** when typed and its recorded exit code is nonzero; absent when
  typed and either still unresolved or exited 0. `cw session setup <name>` (manual
  re-run) is wrapped the same way, so it also updates the recorded code.
- `cw session list`'s SETUP column already printed whatever string the field held, so
  it shows `failed` with no CLI change needed.
- Cockpit's `ListedSession`/`parseSessionList` now carries `setup` through (was
  entirely unparsed before this).

## Gaps

- **Still marked as run when typed, not when it succeeds** (unchanged from before): the
  once-marker (`session_setup.ran_at`) is written at type time. The exit code is a
  separate, later fact — a session whose shell dies before the hook ever runs (crashed
  pty, killed before the command starts) never gets a sentinel and stays in the
  "typed, unresolved" state forever, indistinguishable from "still running". `cw
  session setup` is still the way back for either case.
- **No cockpit badge was built.** The rail had no visual indicator for `setup: 'pending'`
  before this work either — cockpit's own source never parsed the field until now. This
  change makes `setup` available to the renderer; it does not add a badge/UI element
  for it. That is new cockpit UI work, not exit-code tracking, and is out of scope here.
- **A hook that finishes but never reaches the sentinel line** (a script that
  backgrounds itself and returns before the `printf`, or one that replaces the shell
  with `exec`) is never resolved. Realistic hooks (`bun install`, `npm ci`, a normal
  setup script) all return control normally; this is a corner case, not the common path.
- **The OSC number (6961) is arbitrary** and not registered with any terminal
  standard — chosen only to be unlikely to collide with a real terminal feature. A
  future terminal that assigns meaning to OSC 6961 could misbehave; low risk in
  practice (OSC numbers below 1000 are the ones in active use by real terminals).
- **`cw session setup`/`session.start`'s exact typed-string tests, and the daemon-level
  wiring, are unit/integration-tested with a scriptable fake pty** (no real terminal
  needed — `tests/daemon/session-setup-wire.test.ts` plays back a fabricated sentinel
  chunk), so they pass in this sandboxed environment; a true end-to-end run with a real
  shell echoing the sentinel back was not observed live here (`Failed to open PTY`, the
  documented sandbox trap).
