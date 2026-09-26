# Terminal pane — Known Limitations

**Date:** 2026-09-26
**Plan:** `docs/superpowers/plans/2026-09-26-terminal-pane.md`

## What is built

A cockpit **Terminal** button opens `$SHELL -l` in the focused session's worktree
(daemon-owned, `terminal.*` RPCs). Terminal panes now live in the tab/split layout
(Deck-parity phase C), are labelled `shell · not guarded`, close with ×, and are
restored from `terminal.list` after a reload.

## Gaps

- **Not sandboxed (changed 2026-09-26).** The first version wrapped the shell in the
  agent's OS sandbox; the user's own dotfiles then broke (oh-my-zsh, fnm and zsh history
  could not write under `~`, zsh aborted on a history lock). The sandbox is a boundary
  around an agent; this shell is a person typing, so it runs as any terminal does. An
  agent CLI started by hand in it is therefore unconfined.

- **Not guarded.** A shell has no hook, so Collision Radar cannot stop a write typed in
  it; the fs watcher still indexes changes while the session's agent is running. The pane
  says so; it is advisory in the same sense as T3.
- **Cockpit only.** No `cw` CLI verb and no gateway access (`terminal.*` is not in the
  gateway allowlist) — a remote shell is a separate decision.
- **Ephemeral.** Terminals live in the daemon's memory: a daemon restart ends them, and
  nothing is journaled.
- **No leases.** The shell gets `CW_SESSION_ID`/`CW_SESSION_NAME` but not the session's
  port/docker/cache lease env (leases exist only while the agent runs).
- **More than two terminals** can be open (from another window); the grid shows the two
  newest.
- **Focus reports are dropped** in every cockpit pane (see the attach fix), so a
  full-screen program in the shell that relies on focus events will not get them.
