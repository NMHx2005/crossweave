# Project tools — Known Limitations

**Date:** 2026-09-27
**Branch:** `feat/project-tools`

## What is built

- A new session works in the **project folder** unless the project's settings or the
  picker's "Own worktree" ask for a worktree (it used to default to a worktree).
  `new <name>` in ⌘K follows the project default; `--worktree` / `--shared` override.
- **Project menu** (right-click a project): New session, Terminal in project folder,
  Open in editor, Reveal in Finder, Copy path, Land all ready, Clean up ended sessions,
  Hide/Show ended sessions, Rename (display name only), Color, Move up/down (and drag
  and drop), Project settings, Close project — including the active one.
- **Project settings**: display name, color, hide ended, default launcher, own worktree
  by default, the base new worktrees start from.
- **Session menu** adds Rename (F2, or double-click), New terminal here, Open in
  editor, Reveal in Finder, Copy path; Changes/Land are hidden for sessions in the
  project folder (no branch).
- **Git on the rail**: uncommitted files and commits to land per session, read by the
  daemon in the background (`src/daemon/git-counts.ts`).
- ⌘1…⌘9 jump to the Nth row down the rail; a filter box narrows every project's rows.
- The Dock counts sessions waiting for you; Settings can mute the notification sound
  and turn the Dock count off.
- Rename, clean-up and land work on a project off the stage without switching to it
  (the bridge routes `session.rename`, `workspace.gc`, `converge.status`, `land.session`
  to that project's daemon — only for projects open in the window).

## Gaps

- **Display names, colors and project defaults live in this window's storage**
  (localStorage), not in `~/.crossweave`: the CLI and another machine see folder names
  and the worktree default of the daemon. The project order is the bridge's
  `open-projects.json`, per app profile.
- **Git counts refresh when the rail lists sessions** (any activity, a switch, an
  action), at most every 3 s — a file changed in a session whose shell is closed shows
  up on the next list, not by itself. `ahead` is counted against the project's current
  HEAD; a session in the project folder shows uncommitted files only.
- **`.crossweave/` is not counted as a change**, but it still shows in `git status` of
  a project that does not ignore it.
- **Open in editor with the in-app editor chosen reveals the folder in Finder** — the
  in-app editor opens files, not folders.
- **"Terminal in project folder", New session and New terminal here on a project off
  the stage still switch to it** (the window reloads) — a pane can only show the
  active project's shells.
- **Closing a project does not stop its daemon or sessions**; they keep running until
  `cw` stops them or the machine restarts. Opening the folder again shows them.
- **⌘1…⌘9 count collapsed projects' rows too** (collapsing folds the rows away, their
  numbers stay); the row's tooltip shows its number.
- **The Dock count is macOS-only** (`app.setBadgeCount`), like the cockpit.
- **A test that cannot reach the daemon it started leaves it running.**
  `connectOrStart` spawns a detached daemon when nothing answers on the socket; when
  the connection is refused (a sandbox that forbids unix sockets) the test times out
  and the daemon outlives its deleted fixture — 14 were found running from one
  sandboxed `bun test`. Stopping the child on `DAEMON_START_FAILED`, and a daemon that
  exits when its project folder disappears, would both close it.

## Follow-up (2026-09-27): delete a session, clean shell environment

- **Delete…** on a session (right-click) kills it if it is live, then removes its row,
  worktree and branch (`session.rm`); a session in the project folder only loses its
  row. Killed sessions show Delete… only.
- **Session shells no longer inherit an agent session's identity.** A daemon started
  from inside Claude Code (the cockpit launched from its terminal, or `cw` run there)
  handed `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, the session id and the messaging
  socket and token to every shell; `claude` run in a crossweave shell then treated
  itself as a child session and turned transcript saving off. `src/core/shell-env.ts`
  drops them before every pty spawn.

### Gaps

- **The identity list is by name.** A future Claude Code (or another agent CLI) that
  adds a new identity variable passes through until it is listed; a prefix rule was
  rejected because it would also drop settings users export on purpose
  (`CLAUDE_CODE_USE_BEDROCK`, …).
- **Daemons already running keep the old behaviour** until they restart — a shell
  opened by such a daemon still carries the identity it inherited.
- **Delete is not undoable**; the confirmation is the only guard. Unlanded commits on
  the deleted branch are lost (git's reflog keeps them for a while).
