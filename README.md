# crossweave

Your agents run as parallel warp threads. **crossweave is the weft** — the
cross-thread that binds them so the fabric holds together.

[![License](https://img.shields.io/github/license/NMHx2005/crossweave)](LICENSE)
[![Release](https://img.shields.io/github/v/release/NMHx2005/crossweave)](https://github.com/NMHx2005/crossweave/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/NMHx2005/crossweave/ci.yml?branch=main&label=ci)](https://github.com/NMHx2005/crossweave/actions/workflows/ci.yml)
[![Bun](https://img.shields.io/badge/bun-%3E%3D1.3.13-black)](https://bun.sh)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)](#requirements)

crossweave is a local-first cockpit for running many sessions on one repository
and landing them back. A **session is a git worktree plus a shell in it** — like a
tmux window, but each one on its own branch. What runs in that shell is yours to
type: `claude …`, your own `cx` wrapper, `codex …`, a dev server. crossweave does
not pick, configure or launch agents. A background daemon:

- **isolates runtime, not just files** — each session gets its own port block
  (`$PORT`), cache dir and optional DB/Docker names, not just its own checkout;
- **closes the loop** — it trial-merges sessions against each other in the
  background, so `cw land` tells you what is safe to merge and in what order;
- **shows what landing would bring in** — a per-session diff against where it left
  the base, before you land it.

The collision guard (Collision Radar, tiers/Safe Mode, agent adapters, the OS
sandbox) was removed on 2026-09-27; the last version with it is tag `v0.3-radar`.

## Status

Workspace/session management, worktree isolation, per-session leases, the
Convergence Engine, land / land all, notifications, distribution/self-update, the
TUI and the desktop cockpit are built and tested.

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
| Runtime | [Bun](https://bun.sh) 1.3.13+ (earlier 1.3.x has a unix-socket bug that lets a second daemon steal a live one's socket; 1.3.12 itself truncates the code signature on `bun build --compile` macOS output, which gets the binary SIGKILLed on launch) |
| OS | macOS or Linux (Bun's pty support is POSIX-only; Windows is not a V1 target) |
| VCS | git |

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/NMHx2005/crossweave/main/install.sh | sh
```

Installs `cw`/`cwd` to `~/.local/bin` for macOS (arm64/x64) and Linux
(x64). On macOS arm64, releases that carry the Cockpit asset also install it to
`~/Applications/crossweave Cockpit.app` (the installer remains compatible with
older releases that do not carry the app). Every downloaded artifact is
checksum-verified; the installer uses no `sudo` and never edits shell rc files.

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
cw                     # opens the cockpit (macOS) or the TUI

cw session new alice   # a worktree on branch cw/alice
cw session attach alice   # opens its shell (starting it if needed); Ctrl-] detaches
# …in that shell, run whatever you like: claude --model opus, cx, codex, npm run dev

cw session stop alice  # close the shell (and what runs in it); the worktree stays
cw session start alice # open a fresh shell there
```

Check what's safe to merge:

```bash
cw converge status      # pairwise conflict matrix + recommended merge order
cw land all             # land every conflict-free session, in that order
```

Other everyday commands:

| Command | What it does |
|---|---|
| `cw tui` | Live dashboard — sessions, convergence, activity |
| `cw session list` | Sessions, their branch and their leases |
| `cw session path <name>` | A session's worktree (`cd $(cw session path alice)`) |
| `cw gc` | Reclaim worktrees/branches from ended sessions |
| `cw config notify off` | Mute desktop notifications (or `--event land\|convergence`) |
| `cw config trust` | Trust `converge.testCommand` for this workspace |

Full command tree: `cw --help`, and `cw <command> --help` for any
subcommand.

## Cockpit (desktop)

For daily use, **crossweave Cockpit** is an Electron thin client over
`cwd`: ⌘T or ⌘K `new <name>` opens a session's shell at once; tabs, split panes,
extra shells, a file editor, a browser pane, a Changes pane (the diff landing would
bring in) and land / land all. Same daemon and evidence gate as the CLI; the app
never spawns anything itself.
On macOS arm64 the standard installer includes it when the selected release
carries the app asset, and bare `cw` opens it
for the current repository. If the app is absent or cannot launch, `cw`
falls back to the TUI; `cw tui` always selects the terminal dashboard.

| | |
|---|---|
| v1 platform | macOS arm64 only (`macOS-only-v1`) |
| Windows / Linux cockpit | Deferred until `cwd` is portable on those OSes |
| Design | `docs/superpowers/specs/2026-09-17-cockpit-design-system.md` — one token layer (`apps/cockpit/src/ui/tokens.ts`) shared by the chrome and the panes |
| Dev | `cd apps/cockpit && bun install && bun run dev` |
| Package | `cd apps/cockpit && bun run dist:mac` — see `apps/cockpit/README.md` |
| Design | `docs/superpowers/specs/2026-09-16-cockpit-electron-design.md` |

## Configuration

Per-repo settings live in `crossweave.config.json` at the repo root — ports, disk
limits, the DB lease strategy, and `converge.testCommand` (must be explicitly
trusted via `cw config trust` before crossweave will run it — it's arbitrary shell).
Per-user settings (the editor Cmd+click opens, saved cockpit layouts) live in
`~/.crossweave/settings.json`.

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
