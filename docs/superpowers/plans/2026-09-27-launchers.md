# Plan — Launchers, and a cockpit that opens with no project

**Ask (2026-09-27):** open the app on its own (Dock, Spotlight), not only from a
project; several projects in the app; a new session's terminal opens in that project;
start it as a plain terminal or with one of the popular agent CLIs — only those this
machine has, the rest disabled — and let every launch command be edited in detail.
**Tier:** Large — settings schema, RPC params, CLI, the picker, Settings, the welcome.
**Branch:** `feat/launchers`.
**Status:** done (2026-09-27). Gaps: `2026-09-27-launchers-known-limitations.md`.

## Decisions

- A **launcher is a one-line command typed into the session's shell** (plus env for
  that shell), not a process crossweave runs: when the agent exits the user is back at
  a prompt in the worktree, and the status inference (process tree, activity) works as
  for anything typed by hand. "Terminal" is no launcher.
- Built-ins: Claude Code, Codex, Gemini CLI, OpenCode, Cursor Agent, GitHub Copilot CLI,
  Aider, Amp, Qwen Code — each editable (label, command, env, on/off, reset); custom
  launchers are added in Settings. Stored per user in `~/.crossweave/settings.json`.
- **Availability** = the launcher's program on the user's login-shell PATH.
- The daemon resolves `launcher: <id>` itself; `run`/`env` exist for ad-hoc starts.
  The gateway refuses all three.
- With no project given or saved, the bridge reports `NO_PROJECT` instead of opening a
  folder dialog; the cockpit shows a welcome with Open project… and past projects.
