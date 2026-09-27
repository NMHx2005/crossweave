# Launchers and the project-less cockpit — Known Limitations

**Date:** 2026-09-27
**Plan:** `docs/superpowers/plans/2026-09-27-launchers.md`

## What is built

- Launchers in Settings: nine built-in agent CLIs plus custom ones; label, one-line
  command, environment, on/off, reset. Availability from the login-shell PATH.
- ⌘T picker: project, Terminal or a launcher (unavailable ones disabled), name, base,
  isolation; the shell opens in the worktree and the launcher's line is typed into it.
- `new <name> [launcher]` in ⌘K; `cw session start NAME --launcher ID | --run 'cmd'`.
- The cockpit opens with no project: a welcome with Open project… and past projects.

## Gaps

- **Availability checks the program only.** A launcher whose program exists but whose
  flags are wrong, or that needs a login the CLI has not done, shows as installed.
- **Aliases and shell functions are not found by the availability check** (it looks
  for an executable on PATH); such a launcher shows "not installed" and cannot be
  picked. Point it at an executable (a script in `~/.local/bin`) instead.
- **The command is typed before the shell has drawn its prompt.** Shells read it after
  their rc files; a prompt that clears the screen (some themes) may hide the echo.
- **Settings need a project open** — they are read and written through a daemon.
- **Choosing another project in the picker switches to it first** (the window reloads)
  and creates the session there; its branches are not offered as a base until then.
- **Built-in marks are simple original glyphs**, not the vendors' logos.

## Follow-up (2026-09-27): aliases and functions, emoji widths

- **Aliases and shell functions now count as installed.** The daemon asks the user's
  interactive login shell once for its aliases and functions (zsh `${(k)aliases}
  ${(k)functions}`, bash `compgen`; `src/core/shell-names.ts`) — a Claude launcher
  whose command is a `cx` wrapper function was "not installed" and could not be picked.
  Gaps: read once per daemon, so a function added later shows after the daemon
  restarts; shells other than zsh and bash are only checked on PATH; bash reads its
  login files (`.bash_profile`), as the session shell does.
- **Terminal panes use Unicode 11 character widths** (`@xterm/addon-unicode11`).
  xterm's built-in table (Unicode 6) counted an emoji as one cell where Claude Code
  counts two, so its status line wrapped and left doubled or cut lines until the next
  repaint. Gap: grapheme clusters (flags, skin tones, ZWJ sequences) can still be
  measured differently from the program printing them.
