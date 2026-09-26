# Deck parity (daily use + layout) — Known Limitations

**Date:** 2026-09-26
**Plan:** `docs/superpowers/plans/2026-09-26-deck-parity.md`

## What is built

- Agents from per-user settings: Claude Code (T2), Codex, OpenCode, Gemini CLI,
  Antigravity and user-declared commands (all T3). The sandbox opens each agent's own
  state dirs; the sandbox's network is now on by default.
- Resume of each session's own conversation (Claude, Codex, OpenCode), and the agent's
  latest words on the rail (Claude, Codex).
- Agents are found and run on the user's login-shell PATH.
- Cockpit: ⌘T agent picker (agent, name, base branch, own worktree or shared), ⌘⇧A jump
  to attention, ⌘⇧T terminal, ⌘P file quick-open, ⌘⇧B browser pane, ⌘, Settings;
  tabs with drag/pin/close-others/close-right; resizable split panes; named layouts;
  CodeMirror file panes with conflict-safe save; hardened browser panes; session colors;
  Cmd+click on `path:line:col` to the configured editor or an in-app pane.

## Gaps

- **Only Claude Code is guarded.** Codex, OpenCode, Gemini, Antigravity and custom agents
  have no hook crossweave can block through: T3, advisory, and labelled so.
- **Latest words** come from Claude's and Codex's logs only; OpenCode, Gemini,
  Antigravity and custom agents show none. Resume is exact for Claude/Codex/OpenCode and
  a plain relaunch for the rest. All log readers depend on those tools' private formats.
- **Gemini and Antigravity are unverified**: not installed on the development machine.
  Their state paths (`~/.gemini`, `~/.antigravity`) are best guesses.
- **Sandbox network on by default** (decided with the user): an agent can reach any host.
  `sandbox.network: false` restores the old posture — and breaks the agent's own API.
- **Login-shell PATH** is read once per daemon (an interactive `$SHELL -i -l`, 5 s
  timeout); a PATH change in dotfiles needs a daemon restart.
- **Stage state is per window profile** (localStorage, per workspace root). Named layouts
  are per user (settings) and store sessions by name; shells are not saved in them.
- **Divider drag, tab drag and the tab menu** are mouse-only — no keyboard equivalents.
- **File panes**: 2 MB cap, text only; no multi-cursor search-and-replace across files, no
  LSP. Conflict detection is by mtime (a same-millisecond outside write can be missed).
- **Browser panes** share one persistent partition (`persist:cockpit-browser`); there is
  no per-session cookie jar and no devtools button.
- **Session colors** live in the window's storage, not in the daemon: another machine or
  a cleared profile loses them.
- **Release work** (signing, notarization, installer, auto-update) is not in this batch.
