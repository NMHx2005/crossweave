# tmux parity 2C — terminal persistence: known limitations

**Date:** 2026-09-29 · Design: `2026-09-29-cockpit-tmux-parity-design.md` · Branch `feat/terminal-persist`

## What shipped

**Opt-in, off by default** (Settings → Terminal → *Keep terminals across a daemon restart*; named in
`cw config status` as `terminal persistence: on|off`). With it on:

- migration 15 adds a `terminal` table (id, workspace, session, created, snapshot, snapshot time; ON DELETE
  CASCADE on both parents); `TerminalRepo`.
- `TerminalRegistry` records a descriptor on open, snapshots terminals that changed every 30 s, snapshots all of
  them when the daemon goes down (`daemon.shutdown`, SIGTERM, socket loss via `terminal.flush`) and keeps their
  rows; a terminal the user closes, or whose shell ends, is deleted.
- on start the daemon **reopens each terminal whose session and worktree still exist under the same id**, marked
  `restored`, replaying the old output above a new shell (`restoreScrollback`: reset first, the snapshot, leave the
  alternate screen / mouse / paste modes, show the cursor, then a note saying it is a new shell). Others are dropped.
- **files are private while it is on:** `.crossweave/` is 0700 and `state.db` (+ wal, shm, `journal.json`) 0600.
- **switching it off** deletes every stored snapshot at the next flush, and at the next daemon start.

Verified with a real daemon (`apps/cockpit/scripts/persist-check.ts`): off — nothing comes back; on — the terminal
returns under the same id, marked restored, its output replayed, "new shell" note, `state.db` 0600, `.crossweave` 0700.

## Limitations

- **A new shell, not the old process.** Running programs, history in memory and environment are gone; this is not
  tmux's server surviving. Only *extra terminals* are restored, never sessions.
- **A hard kill loses up to 30 s of output** (SIGKILL, power loss): the last periodic snapshot is what returns.
- **A snapshot is output at rest** and may contain anything that was printed or typed. It is deleted on close, when
  the shell ends, when the session is removed or gc'd (cascade), and when the switch goes off. It sits in the
  project's SQLite file, mode 0600 once the switch has been on; a `state.db` made earlier stays 0644 until then.
- **A raw VT tail of 64 KB**, cut to a line boundary and without a dangling escape; alternate-screen state and
  scrollback beyond that are lost, and colours/cursor state are reset at the seam.
- **The stale device answers a replay provokes** are suppressed by the cockpit's existing replay window
  (`replayAnsweredUntil`); that window is not separately unit-tested for a restored snapshot.
- **The setting is per user, the data per project.** A daemon older than the app ignores the setting (the app keeps it
  in the file for when that daemon is restarted).
- **`snapshot` is a TEXT column**, not a blob: it holds the terminal's output string as the daemon saw it.
