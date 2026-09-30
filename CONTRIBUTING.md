# Contributing

Thanks for looking. crossweave is a small project with strong opinions; reading this page first saves a round trip.

## Ground rules

- **Read `AGENTS.md`.** It is the project's working contract: the map of the code, the commands, the traps, and the decisions already
  made (do not relitigate them in a pull request — for example: no agent picker, no collision guard, no browser remote control, no in-app
  voice input, no native Node modules).
- **Design first for anything bigger than a small fix.** A spec under `docs/superpowers/specs/` and a plan under
  `docs/superpowers/plans/` come before code (see the existing ones for the shape). Open an issue to talk it through first.
- **Every gap you find is written down** in that feature's `*-known-limitations.md` and one line in
  `docs/superpowers/specs/2026-08-14-known-limitations-digest.md` — not only in the pull request.
- **Zero native modules.** A dependency that ships a `.node` binary is grounds for rejecting a change.
- macOS and Linux only; Windows is not a target.

## Setup

```bash
git clone https://github.com/NMHx2005/crossweave && cd crossweave
bun install                       # Bun >= 1.3.13
cd apps/cockpit && bun install && bun node_modules/electron/install.js   # the cockpit; Electron's binary is fetched explicitly
```

## The gate (run it before you push)

```bash
bun run typecheck                 # tsc --noEmit (src/ and tests/)
bun test --max-concurrency=1      # the whole suite, including the cockpit's tests
bun run build                     # dist/cw, dist/cwd
cd apps/cockpit && bun test && bun run build     # the cockpit typechecks in its own build
```

Tests that spawn a pty or bind a unix socket cannot pass in a restricted sandbox; run the gate outside one. CI runs the same commands.

## How changes are made

- **Tests first.** New behaviour ships with tests, a bug fix with a regression test that fails before the fix. Test behaviour and
  contracts, not log strings or private internals. No real network, clock or randomness without a seam. Never weaken a test to make it pass.
- **Comments say WHY** (a race that was closed, an alternative that was rejected), not what.
- **Errors** are `CrossweaveError` with a string code; user-facing text is English; the CLI prints exactly one `CODE: message` line.
- **Migrations are append-only.** Never edit one that may have run; a new change is a new version.
- **Commits**: one logical change each, Conventional Commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`), imperative and
  specific — what changed and why. `main` stays linear (fast-forward merges).
- **UI changes** get a look at the running app: the cockpit has a script per feature under `apps/cockpit/scripts/` that drives the real
  app over CDP on a scratch `HOME` (see `apps/cockpit/README.md`). Never run them against a real project.

## Reporting bugs and security problems

Bugs: open an issue with the version (`cw --version`), OS, and the smallest steps that reproduce it (`.crossweave/daemon.log` helps).
Security problems: **do not** open a public issue — see `SECURITY.md`.
