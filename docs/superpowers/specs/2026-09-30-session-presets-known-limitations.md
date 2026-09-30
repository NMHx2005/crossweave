# Session presets — design note and known limitations

Backlog item 6 (2026-09-27). Small enough for one note instead of a spec plus a plan: the model is one settings block, one
pure planner and one launch sequence in the window.

## What shipped

`presets` in the user's settings file (`~/.crossweave/settings.json`), edited in **Settings → Presets**: a name, a launcher
(or a plain terminal), own worktree or the project folder, up to 4 commands (one extra terminal each) and an optional Browser
pane on the session's leased port at a path. The new-session picker (⌘T) lists them under "Or start a preset", each with
one line saying what a click will do. A click creates the session, starts the launcher, opens each terminal beside it and types
and runs its command, then opens the Browser pane on `http://localhost:<leased port><path>`, and toasts `Started <name>`.
Validation is in `cleanPresets` (at most 12 presets, unique one-line names, launcher id in the launcher-id pattern, commands
one plain line of at most 500 characters, a path that starts with a single `/`). The main-process settings guard mends the block
for a daemon older than the app. Measured on the real app with `apps/cockpit/scripts/preset-check.ts` (6 checks).

## Security note

The commands are **typed and run for you**, so they are as powerful as anything you type. They live only in the user's own
settings file: a repository can neither add nor change a preset, which is why there is no trust step here (a repository's
`hooks.sessionSetup`, which does arrive from a clone, has one). Anything that can write `~/.crossweave/settings.json` as the user
can add a preset that runs on the next click; that is the same reach it already has over the launchers' commands. Commands are
control-character free, so one line cannot smuggle a second command in an escape sequence or a newline.

## Limitations

- **Presets apply to the active project only** in the picker (not when another project is chosen, and not for a plain folder,
  which has no worktree to choose).
- The dev server is expected to listen on the session's **leased port**; if the project's config leases none, the Browser pane
  is skipped and the toast says so. Nothing waits for the server to be up: the pane may show a connection error until it is.
- A command is typed into a fresh shell that may still be starting; it is queued by the terminal, but a shell whose start-up
  is slow or asks a question can eat the first characters.
- Commands run in the session's own worktree only (an extra terminal's cwd); there is no per-command directory.
- Order is fixed: session, terminals in the list's order, then the Browser pane. Nothing is undone if a later step fails.
- No preset import/export, no preset for the CLI (`cw`), and the name is chosen by the picker (the preset name, or the name field
  if edited), not asked.
