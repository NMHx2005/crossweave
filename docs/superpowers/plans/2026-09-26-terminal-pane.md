# Plan — Terminal pane (a shell in a session's worktree)

**Ask:** "option 1" (2026-09-26): after Ctrl-C the agent exits and there is no shell under
it, unlike tmux. Add a separate Terminal pane that opens `$SHELL` in the focused
session's worktree, next to the agent pane.
**Tier:** Medium-Large — new daemon RPC surface, cockpit IPC allowlist, UI.
**Branch:** `feat/terminal-pane`.

## Design

- **The daemon owns the shell**, like every other process: `TerminalRegistry`
  (`src/daemon/terminals.ts`) spawns `$SHELL -l` in a pty in the session's worktree,
  wrapped in the **same OS sandbox spec** the session's agent gets (`decideSandbox`).
  `HISTFILE` points into the session's sandbox temp dir, since `~` is not writable there.
- Terminals are **ephemeral**: not in the database. They end when the shell exits, on
  `terminal.close`, when their session is killed/removed/landed/gc'd (its worktree is
  going away), and on daemon shutdown.
- **RPC:** `terminal.open {workspaceId, idOrName}` → `{terminalId, sessionId, sessionName}`,
  `terminal.list {workspaceId}`, `terminal.attach|input|resize|close {terminalId}`.
  Notifications `terminal.data {terminalId, sessionId, workspaceId, chunk}` (sealed like
  `session.data`, AAD = terminalId) and `terminal.exit {terminalId, code}`.
- **Honesty:** a shell's writes are not intercepted by Collision Radar (no hook); the pane
  is labelled `shell · not guarded` — the same "advisory" standing as T3.
- **Not exposed through the gateway** (not in `ALLOWED_METHODS`): a remote shell is a
  bigger decision than this ask.
- **Cockpit:** a `Terminal` button in the rail opens one for the focused session. Terminal
  panes share the 4-pane grid (at most 2 open per window), each with a close button.
  `terminal.list` on load restores panes after a window reload, so no shell is orphaned
  behind a lost UI state.

## Tasks

1. Extract the pty plumbing (`PtyProcess`, spawn-in-pty) to `src/adapters/pty.ts`; add
   `ShellPtyAdapter`.
2. `TerminalRegistry` + tests (open/list/data/exit/close/closeForSession, sealing).
3. RPC methods + lifecycle hooks (kill/rm/land/gc/shutdown) + tests.
4. `DaemonClient` opens sealed `terminal.data` like `session.data`.
5. Cockpit: channels/events, bridge forwarding, api, pane source abstraction, Stage/App/
   rail button, tests; verify in the running app.
6. Docs: known limitations.

## Gate

`bun run typecheck` · `bun test --max-concurrency=1` · `bun run build` · cockpit build +
tests + a look at the running app.
