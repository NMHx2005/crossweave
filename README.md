# crossweave

Your agents run as parallel warp threads. **crossweave is the weft** — the
cross-thread that binds them so the fabric holds together.

[![License](https://img.shields.io/github/license/NMHx2005/crossweave)](LICENSE)
[![Release](https://img.shields.io/github/v/release/NMHx2005/crossweave)](https://github.com/NMHx2005/crossweave/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/NMHx2005/crossweave/ci.yml?branch=main&label=ci)](https://github.com/NMHx2005/crossweave/actions/workflows/ci.yml)
[![Bun](https://img.shields.io/badge/bun-%3E%3D1.3.5-black)](https://bun.sh)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)](#requirements)

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
- **makes disk and cost visible** — a live TUI dashboard, budget/burn
  tracking, and desktop notifications for collisions, blocked writes, land
  results, and convergence state changes.

See `docs/superpowers/specs/2026-08-09-crossweave-design.md` for the full
design and the milestone-by-milestone rollout.

## Status

Core loop (workspace/session management, worktree isolation, Collision
Radar, Convergence Engine, Safe Mode enforcement, budget tracking, push
notifications, distribution/self-update, live TUI dashboard) is built,
tested, and released — [`v0.1.0`](https://github.com/NMHx2005/crossweave/releases)
is the current published version.

> [!NOTE]
> Interactive TTY testing of the TUI (`cw tui`) has been reviewed but not
> yet manually exercised end-to-end by a human. Known gaps are tracked in
> `docs/superpowers/specs/2026-08-14-known-limitations-digest.md` (the
> short version — start here) and per-milestone in
> `docs/superpowers/specs/*-known-limitations.md` — worth a skim before you
> lean on crossweave for anything you'd be upset to lose.

## Requirements

| | |
|---|---|
| Runtime | [Bun](https://bun.sh) 1.3.5+ |
| OS | macOS or Linux (Bun's pty support is POSIX-only; Windows is not a V1 target) |
| VCS | git |

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/NMHx2005/crossweave/main/install.sh | sh
```

Installs `cw`/`cwd` to `~/.local/bin` for macOS (arm64/x64) and Linux
(x64) — see `install.sh` at the repo root for exactly what it does
(checksum-verified download, no `sudo`, no shell rc file edits).

`cw` checks for a newer version in the background (cached, at most once a
day) and tells you to run `cw update` when one exists — never installs
anything without you running that command. Turn it off with `cw config
update-check off`.

### From source (for crossweave's own development)

```bash
git clone https://github.com/NMHx2005/crossweave crossweave
cd crossweave
bun install
bun run scripts/build.ts   # produces dist/cw and dist/cwd
```

## Quickstart

```bash
cd your-project        # any git repo
cw init                # create/attach this repo's crossweave workspace

cw session new --name alice --agent claude
cw session new --name bob   --agent claude

cw session attach alice     # Ctrl-] to detach, agent keeps running
```

> [!TIP]
> Run `cw tui` in a separate terminal to watch both sessions live — session
> list, convergence matrix, and a real-time collision/notification feed in
> one dashboard.

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

| Command | What it does |
|---|---|
| `cw tui` | Live dashboard — sessions, convergence, radar feed |
| `cw session list` | What's running, budget spent, status |
| `cw blame <path>:<line>` | Which session committed this line |
| `cw gc` | Reclaim worktrees/branches from ended sessions |
| `cw config notify off` | Mute desktop notifications (or `--event <kind>`) |
| `cw config trust` | Trust `converge.testCommand` for this workspace |

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
bun run build      # dist/cw, dist/cwd
```

See `docs/superpowers/plans/` and `docs/superpowers/specs/` for how each
milestone was designed and implemented.

## License

[MIT](LICENSE)
