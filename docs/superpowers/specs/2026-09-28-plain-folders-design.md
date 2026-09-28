# Opening folders that are not git repositories — design

**Date:** 2026-09-28 · **Status:** approved by the user (all three options chosen)
**Plan:** `docs/superpowers/plans/2026-09-28-plain-folders.md`

## Problem

Opening `/Users/nmh/work/Win` (no git) failed with "Daemon did not come up within
10000ms". The daemon had exited at once with "Not inside a git repository"; the client
never saw that and waited out its timeout.

## Decisions (the user's, 2026-09-28)

1. **Say why, and offer `git init`.** Before starting a daemon, the cockpit classifies
   the folder. A folder that is not a repository opens a dialog instead of an error.
2. **A limited mode for plain folders.** A plain folder opens with sessions in the
   folder itself only: terminals and agents work; worktrees, branches, Land, diff,
   convergence and git badges are off.
3. **List the repositories inside.** A folder that holds projects (like `work/Win`)
   shows the git repositories found beneath it, to open one or several.

## Shape

- `src/core/folder-kind.ts` — `folderKind(path)`: `repo` (its own top level),
  `inside-repo` (a subfolder: offer the repository's root), `plain`, or `missing`; and
  `findRepos(path)`: repositories beneath it, depth ≤ 3, skipping hidden folders and
  `node_modules`, not descending into a repository, at most 50.
- **Cockpit, before any daemon:** the bridge classifies the folder. `repo` opens as
  today. Anything else returns a structured refusal (`FOLDER_NOT_A_REPO`, with the kind,
  the repositories found and the repository root) and the renderer shows the **Open
  folder** dialog:
  - the repositories inside, each with Open;
  - for `inside-repo`: Open the repository (its root);
  - **Initialize git here** — after a confirm: `git init`, then an empty first commit
    when `user.name`/`user.email` are set (worktrees need one), else say so;
  - **Open as a plain folder** (limited mode).
- **Daemon start fails fast:** `connectOrStart` notices the child exiting before its
  socket appears and says so at once, instead of after 10 s.
- **Limited mode (daemon):** a plain folder is opened only when the cockpit asks for it
  (`CW_PLAIN=1` on the daemon it starts), so a mistyped `cw` in a random folder still
  refuses. The workspace reports `git: false`; `session.new` forces the project folder;
  git counts, branches, diff, land, converge and the scheduler are off; `file.list`
  walks the folder (bounded) instead of `git ls-files`. No schema change: whether a
  workspace has git is read from disk each start, so running `git init` later simply
  lights the git features up.
- **Limited mode (cockpit):** the project is marked "folder" in the rail; the New
  session picker has no worktree choice; Land, Changes and git badges are hidden.

## Not in scope

- A plain folder becoming a repository while its daemon runs (restart the project).
- Non-git version control (hg, svn).
