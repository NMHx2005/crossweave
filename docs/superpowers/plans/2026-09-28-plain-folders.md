# Plain folders — plan

Spec: `docs/superpowers/specs/2026-09-28-plain-folders-design.md`. Branch:
`feat/plain-folders`. TDD; one commit per task.

## Part 1 — say why, init, list repositories

1. `src/core/folder-kind.ts`: `folderKind`, `findRepos` (bounded walk). Tests over temp
   folders: repo, subfolder, plain, missing, nested repos, skipped folders, caps.
2. `connectOrStart` fails fast when the daemon exits before its socket appears. Test with
   an entry that exits immediately.
3. Bridge: classify before attaching; refuse with `FOLDER_NOT_A_REPO` and its details.
   Main: `folder.initGit` (argv-only `git init` + optional empty commit). Channels.
4. Renderer: the Open folder dialog (repositories inside, open the repository root,
   Initialize git here with a confirm, Open as a plain folder — enabled in part 2).
   CDP check on a temp folder tree.

## Part 2 — limited mode

5. Daemon: `CW_PLAIN=1` lets a non-git folder be the root; `workspace.info`/`init`
   report `git: false`; `session.new` forces the folder; git counts, branches, diff,
   land, converge, scheduler off; `file.list` walks the folder. Tests.
6. Bridge/main: "Open as a plain folder" starts that daemon with `CW_PLAIN=1`; plain
   projects remembered as such.
7. Cockpit: rail tag, picker without worktrees, no Land/Changes/git badges. CDP check.
8. Known limitations + digest; gates; install.
