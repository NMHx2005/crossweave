# Opening folders that are not git repositories — known limitations

**Date:** 2026-09-28 · Design: `2026-09-28-plain-folders-design.md` · Plan:
`../plans/2026-09-28-plain-folders.md`

What shipped: choosing a folder that is not a repository's top level opens the **Open
folder** dialog instead of timing out — the repositories inside it (open one or
several), the repository a subfolder belongs to, **Initialize git here** (confirmed; git
init plus an empty first commit when git knows the user), and **Open as a plain
folder**: sessions run in the folder itself, and worktrees, branches, Land, diff, git
counts and convergence are off. The rail marks such a project "folder". A daemon that
exits as it starts is now reported at once.

- **Plain folders open from the app only.** `cw` in a folder without git still refuses
  (`NOT_A_REPO`), by design: a stray command must not make a folder a project. The
  daemon serves one only when started with `CW_PLAIN=1`, which the cockpit sets for the
  folders the user chose (`plain-projects.json` in the app's data).
- **A plain folder that later gets git** keeps running without it until its daemon
  restarts (close the project and reopen it, or restart the app after its sessions end).
- **Initialize git without a first commit** (git does not know the user's name/email):
  the project opens, but a session in its own worktree fails until a commit exists.
- **Finding repositories inside** reads at most 3 levels, 2000 folders, and lists 50;
  hidden folders and `node_modules`, `build`, `dist`, `target`, `vendor`, `Pods`,
  `Library` are skipped.
- **A plain folder's file list** (quick open, the in-app editor) walks the folder with no
  `.gitignore` to honour: hidden folders and `node_modules` are skipped, 20 000 files at
  most.
- A plain folder gets a `.crossweave/` folder of its own, as any project does.
