# Command-first cockpit and the UX review's fixes — Known Limitations

**Date:** 2026-09-26
**Plan:** `docs/superpowers/plans/2026-09-26-command-first.md`

## What is built

- Creating a session never starts it. A stopped session's pane docks a launch line
  (agent command from Settings + the session's remembered flags); Enter starts it through
  crossweave, so the hook, sandbox and resume still apply. Flags are stored per session
  (`session.launch_args`, migration 12) and reused on every start/resume;
  `cw session new|start NAME -- FLAGS` does the same from the CLI.
- ⌘K command bar with `cw`'s verbs, completion and history; rail buttons off by default.
- Changes pane (`session.diff`): the land verdict, conflict partners and the diff that
  landing would bring in. `converge.status` gains `empty` (no commits yet — not "ready")
  and `baseBranch`.
- Fixes from the external UX review: stopped sessions show their conflict/readiness; a
  deep project path connects (short socket link); renderer calls wait for the attach and a
  dead daemon shows Retry; in-app confirmation; workspace header; usage moved to Settings;
  plain tier labels; one tab on first load; keyboard tabs; menus dismiss on Esc/outside;
  the gateway web client serves xterm itself under a same-origin CSP.

## Gaps

- **A launch line cannot change the program.** It must begin with the agent's command in
  Settings; a different binary is a Settings edit (or a custom agent). Deliberate: which
  program runs under a session's identity is not a per-start choice.
- **Launch flags are local-only.** The gateway refuses any `args` param, so a remote
  client can start a session only with its remembered flags.
- **Claude's `--settings` is refused as a launch flag** (crossweave's carries the Radar
  hook). A user who needs extra Claude settings must put them in `~/.claude/settings.json`.
- **Flags are not validated against the agent.** A misspelt flag is stored and passed;
  the agent's own error shows in the pane.
- **The Changes pane diffs commits only.** Uncommitted worktree files are counted, not
  shown; the patch is cut at 512 KB (`git diff` in a shell has the rest).
- **"Nothing to land" is commits-only.** A session with only uncommitted edits reads as
  empty, which is accurate for landing but can surprise.
- **The Vietnamese Telex report is unresolved.** Duplicated text ("claude-claude1claud…")
  in the picker could not be reproduced with real Telex keystrokes through System Events;
  Enter/arrows are now left to a composing IME in every cockpit input, which closes one
  plausible path, but the reported sequence is still unconfirmed.
- **Command bar history and the buttons toggle are per viewer** (localStorage), not
  synced between machines.
- **The CLI TUI still shows no on-screen key hints**, and the gateway web client keeps its
  own palette rather than the cockpit's tokens (review items 17a/17b).
- **Old daemons and the new schema:** a daemon older than migration 12 refuses a database
  a newer one has migrated. Update `cw`/`cwd` and the cockpit together.
