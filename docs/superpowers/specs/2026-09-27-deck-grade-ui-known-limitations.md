# Deck-grade cockpit — Known Limitations

**Date:** 2026-09-27
**Plan:** `docs/superpowers/plans/2026-09-27-deck-grade-ui.md`

## What is built

- Status inferred from each session's shell (daemon): `working` while output flows,
  `asked` after a bare bell or when a detected agent goes quiet after its turn, `failed`
  when the shell died non-zero on its own, else `idle`; the agent CLI found under the
  shell by one `ps` sweep; the last activity time. Broadcast only on change.
- Many projects in one window: the bridge keeps a daemon connection per open project;
  the rail lists them all; choosing a session elsewhere makes that project active.
- Deck-style rail rows (glyph, latest words, time, agent mark, land/conflict chip),
  hidden-inset title bar, tab icons and titles, no pane title bar, ⌘D / ⌘⇧D / ⌘W /
  ⌘\\ / ⌘O, a toast instead of the footer, a desktop notification when a session starts
  waiting while the window is not focused.

## Gaps

- **`asked` is a heuristic.** An agent that pauses for more than ~2.5s mid-turn without
  output (a long tool call with no spinner) reads as asking until it prints again; a
  plain shell never reads as asking unless it rings the bell.
- **Agent detection needs the process to be under the session's shell.** An agent
  started in another terminal and pointed at the worktree is not seen; an agent run
  through `ssh`, `docker exec` or a multiplexer inside the shell is not either.
- **`failed` only covers the shell itself** exiting non-zero on its own; an agent that
  errors and returns to its prompt is `idle`/`asked`, not `failed`.
- **Switching project reloads the window** onto it (tabs come back from storage); panes
  of the previous project close, and their shells keep running in their daemon.
- **Every open project keeps a daemon running** while the window lists it; close a
  project from the rail to let its daemon go idle.
- **Latest words come only from Claude Code and Codex logs**; other agents' rows show
  the session name as their title.
- **Traffic-light placement is macOS-only** (`hiddenInset`); the cockpit is macOS-only
  anyway (`macOS-only-v1`).
- **Background projects' conflict verdicts** refresh on their own daemon's invalidation,
  not on a timer; a trial merge that finishes silently shows on the next change.
