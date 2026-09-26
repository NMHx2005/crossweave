# Plan — Shell sessions: crossweave becomes a worktree + terminal cockpit

**Ask (2026-09-27):** a session is a worktree plus a terminal, like a tmux window. Start
opens the user's shell there; the user types whatever launches their tools (`cx`, a
custom `claude …`, `codex …`). No AI choice, no auto-launch, no flags UI. Remove the
collision guard ("sửa trùng file") entirely, from the app, the CLI and the daemon. The
target is a SpaceVibe-Deck-like tool, standardised for the user's own use.
**Tier:** Large — removes modules, changes the session model, RPCs and the CLI surface.
**Branch:** `feat/shell-sessions`. The last version with the guard is tagged `v0.3-radar`.
**Status:** done (2026-09-27), phases A–D. Gaps: `2026-09-27-shell-sessions-known-limitations.md`.

## Decisions (asked, answered)

- Remove **Collision Radar** and everything that exists only for it: the claim indexer,
  contracts, the blocking policy, `cw blame`/`cw contract`, the Claude hook, tiers
  T1/T2/T3 and their coverage labels, Safe Mode.
- Remove the **agent model**: adapters (claude, codex, cursor/ACP, custom), the agent
  catalog in Settings, launch lines and launch flags, conversation resume, `--agent`.
  Migration 12's `session.launch_args` column stays (migrations are forward-only) and is
  no longer read or written.
- Remove the **per-session MCP server** and the usage/cost hook (both fed by agent hooks).
- **No OS sandbox**: the session shell runs as the user's own shell, dotfiles and all.
- **Keep**: worktrees and their base picker, port/cache leases (a session's `PORT`),
  trial merges and the land verdict (`ready` / `conflict with X` / nothing to land),
  Land / Land all, the Changes pane, terminals and extra shells, tabs/splits/layouts,
  file and browser panes, the ⌘K command bar, the gateway, `cw tui`, latest words
  (read from Claude/Codex logs by worktree path, whatever launched them).
- Creating a session **starts its shell** (a terminal is the session's whole point);
  Stop ends the shell and whatever runs in it; Start opens a new one.

## Phases

**A — Daemon and core**: the shell is the session process; delete radar, adapters
(except the pty/shell primitives), mcp, sandbox, the usage hook; strip their RPCs,
watchers, scheduler hooks, notifications; settings keep editor + layouts.
**B — CLI and TUI**: drop radar/contract/blame/hook commands and `--agent`/flags.
**C — Cockpit**: picker = name + base + isolation; no launch line, tiers, agent
settings; command bar without agents or flags.
**D — Gateway, docs, AGENTS.md**: allowlists, the project rules' "decisions already
made", known limitations + digest.

Gate per phase: `bun run typecheck` · `bun test --max-concurrency=1` · `bun run build`;
cockpit phases add `cd apps/cockpit && bun test && bun run build` and a CDP look.
