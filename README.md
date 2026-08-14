# crossweave

Your agents run as parallel warp threads. **crossweave is the weft** — the
cross-thread that binds them so the fabric holds together.

crossweave is a local-first tool that makes running many AI coding agents on
one repository *safe and mergeable*. It is not a coding agent — it's the
layer that sits above Claude Code, Cursor Agent, and any
[ACP](https://agentclientprotocol.com)-compatible agent, running each one in
its own git worktree while a background daemon:

- **isolates runtime, not just files** — separate ports, DB, Docker, cache
  per session, not just separate working directories;
- **warns at write time** — the Collision Radar flags two sessions editing
  the same file/symbol before it becomes a merge conflict;
- **closes the loop** — the Convergence Engine trial-merges sessions against
  each other in the background, so `cw land` tells you what's safe to merge
  and in what order, instead of "create a staging branch by hand and pray";
- **makes disk and cost visible** — budget/burn tracking and desktop
  notifications for collisions, blocked writes, land results, and
  convergence state changes.

See `docs/superpowers/specs/2026-08-09-crossweave-design.md` for the full
design and the milestone-by-milestone rollout.

## Status

Core loop (workspace/session management, worktree isolation, Collision
Radar, Convergence Engine, Safe Mode enforcement, budget tracking, push
notifications) is built and tested. Two things are **not** built yet:

- **No TUI.** There's no live dashboard — you follow along via `cw ... list`/
  `status` commands and desktop notifications.
- **No installer.** Today crossweave only runs from a source checkout (see
  Install below). No `curl | sh` script, no package-manager tap, and no
  self-update mechanism exist yet.

Known gaps are tracked in
`docs/superpowers/specs/2026-08-14-known-limitations-digest.md` (the
short version — start here) and per-milestone in
`docs/superpowers/specs/*-known-limitations.md` — worth a skim before you
lean on crossweave for anything you'd be upset to lose.

## Requirements

- [Bun](https://bun.sh) 1.3.5+
- macOS or Linux (Bun's pty support is POSIX-only; Windows is not a V1
  target)
- git

## Install (from source — today's only option)

```bash
git clone <this-repo> crossweave
cd crossweave
bun install
bun run scripts/build.ts   # produces dist/cw and dist/cwd
```

Put `dist/` on your `PATH`, or invoke the binaries directly:

```bash
export PATH="$PWD/dist:$PATH"
```

`cw` is the CLI you run; `cwd` is the daemon it starts automatically the
first time you need it — you never run `cwd` by hand.

## Quickstart

Run this against a small, low-stakes repo first — see Status above.

```bash
cd your-project        # any git repo
cw init                # create/attach this repo's crossweave workspace

cw session new --name alice --agent claude
cw session new --name bob   --agent claude

cw session attach alice     # Ctrl-] to detach, agent keeps running
```

While both sessions work, crossweave's daemon is already:

- indexing every file+symbol each session touches (Collision Radar) and
  warning both sessions the moment they edit the same symbol;
- trial-merging their branches against each other in the background
  (Convergence Engine).

Check what's safe to merge:

```bash
cw converge status      # pairwise conflict matrix + recommended merge order
cw land all             # land every conflict-free session, in that order
```

Other everyday commands:

```bash
cw session list                 # what's running, budget spent, status
cw blame <path>:<line>          # which session committed this line
cw gc                           # reclaim worktrees/branches from ended sessions
cw config notify off            # mute desktop notifications (or --event <kind>)
cw config trust                 # trust converge.testCommand for this workspace
```

Full command tree: `cw --help`, and `cw <command> --help` for any
subcommand.

## Configuration

Per-repo settings live in `crossweave.config.json` at the repo root
(created by `cw init`) — Safe Mode tier, budget defaults, notification
preferences, and `converge.testCommand` (must be explicitly trusted via
`cw config trust` before crossweave will run it — it's arbitrary shell).

## Contributing / development

```bash
bun test           # full suite
bun run typecheck  # tsc --noEmit
bun run build       # dist/cw, dist/cwd
```

See `docs/superpowers/plans/` and `docs/superpowers/specs/` for how each
milestone was designed and implemented.

## License

MIT
