# Shell sessions — Known Limitations

**Date:** 2026-09-27
**Plan:** `docs/superpowers/plans/2026-09-27-shell-sessions.md`

## What is built

- A session is a git worktree plus the user's login shell in it. `cw session new`
  creates it; the cockpit (⌘T, or `new` in the ⌘K bar) creates it and opens the shell
  at once. Whatever runs there is the user's to type.
- Stop hangs the shell up (SIGHUP, then SIGKILL); start opens a fresh one.
- Kept: port/cache/DB leases (`$PORT` in the shell), trial merges and the land verdict,
  land / land all, `session.diff` and the Changes pane, extra terminals, tabs/splits,
  file and browser panes, the command bar, the gateway, the TUI, notifications for land
  and convergence, latest words on the rail.

## Removed (tag `v0.3-radar` has them)

Collision Radar, contracts, `cw blame`, tiers and Safe Mode, the Claude hook, agent
adapters (claude, codex/CLI, cursor ACP and print), the agent catalog, launch flags,
conversation resume, the per-session MCP server, usage/cost tracking and budgets, the
OS sandbox, the Deck bridge.

## Gaps

- **Nothing stops two sessions editing the same file.** That was the Radar's job. The
  only signal left is after the fact: a trial merge that conflicts, shown as
  `conflict` on the rail and in the Changes pane.
- **No sandbox.** The shell and everything run in it can write anywhere the user can.
- **Latest words are a guess about what ran.** They come from Claude Code's or
  Codex's own log for the worktree path, whichever was written last; another agent
  shows nothing, and a conversation started outside the worktree is not found.
- **No resume.** Starting a session opens a new shell; resuming a conversation is the
  agent's own command (`claude --resume`, `codex resume`), typed by the user.
- **No spend.** Cost and token counts came from the Claude hook; the columns remain in
  the database and are no longer written or shown.
- **Old flags are silently wrong, not rejected.** citty ignores unknown flags, so
  `cw session new --name a --agent claude` creates a session named `claude`. Scripts
  written for 0.3 need their `--agent` removed.
- **Unused schema.** Tables and columns for claims, contracts, messages, context,
  launch flags, tiers and budgets stay (migrations are forward-only). A later migration
  could drop them once no older daemon needs to open the file.
- **The shell's prompt shows the worktree's id**, not the session name: worktrees live
  at `.crossweave/worktrees/<session-id>` so a rename never moves them.
