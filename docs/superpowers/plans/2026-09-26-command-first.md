# Plan — Command-first cockpit, and the UX review's fixes

**Ask (2026-09-26):** (1) creating a session must not start its agent — the user runs
agents with their own flags (`--dangerously-skip-permissions`, `--model …`) and wants to
type them; (2) developers prefer commands to buttons: a CLI-like command bar, action
buttons hidden by default (can be turned on); (3) fix everything in the external UX
review (phases A–D below).
**Tier:** Large — a schema migration, RPC params, the gateway boundary, cockpit layout.
**Branch:** `feat/command-first`, one commit per task, reported per phase.
**Status:** done (2026-09-26), phases A–D. Gaps: `2026-09-26-command-first-known-limitations.md`.

## Decisions (asked, answered)

- **Create ≠ start.** ⌘T / `new` creates the session and its worktree only. The pane
  shows a launch line prefilled with the agent's command (Settings) plus the session's
  remembered flags; Enter starts it. The agent still starts *through crossweave*, so the
  Claude hook (T2), the sandbox, resume and latest-words all keep working — the rejected
  alternative (a plain shell where the user types `claude …`) loses every one of them.
- **Command bar ⌘K**, CLI syntax (`new api claude --model opus`, `start`, `stop`, `kill`,
  `land`, `diff`, …), with completion and history. Rail buttons are off by default; a
  Settings checkbox turns them back on.
- **Flags are remembered per session** (a nullable `session.launch_args` JSON column):
  Start and resume reuse the last line; the per-agent default stays in Settings.

## Security boundary

- Launch flags reach an agent's argv, and an agent flag can run code (Claude's
  `--settings` can declare hooks). They are accepted from **local clients only** — the
  gateway refuses any `args` param, so a remote control token cannot become a remote
  command line.
- Claude's `--settings` is crossweave's (it carries the Radar hook). A user `--settings`
  is refused rather than silently merged, so T2 is never quietly switched off.
- Args are argv, never a shell string (`splitCommand`), bounded in count and length.

## Phases

**A — Correctness (review P0)**
1. Long project paths: Node's `connect()` (Electron) fails `EINVAL` past the 104-byte
   `sun_path` limit where Bun's does not — the cockpit hung on "Connecting…" while the CLI
   worked, and every retry spawned another daemon. Connect through a short symlink in a
   private temp dir.
2. Attention: a stopped session still shows its landability (`stopped · conflict`,
   `stopped · ready`) instead of a grey `stopped`.
3. Startup: renderer calls wait for the in-flight `workspace.ensure` instead of failing
   (`settings.get` lost saved layouts); an ensure failure reaches the UI as an error with
   Retry instead of an endless "Connecting to cwd…".

**B — Command-first**
4. `session.launch_args` migration + repo; `session.new/start/resume` accept `args`;
   adapters append them; the gateway refuses them; CLI `cw session start <name> -- …`.
5. Cockpit: create without starting; launch line in a not-running pane (↑ recalls).
6. Command bar ⌘K (parser in `lib/commands.ts`, pure and tested); buttons toggle.

**C — Actions and information**
7. Header: workspace, base branch, running count, spend. Session action bar names the
   session ("Land auth-refactor"); Kill is red and set apart; in-app confirm dialog
   replaces `window.confirm`; entry points for Settings, Open file, Browser, Attention.
8. Changes pane: `session.diff` RPC (stat + capped patch against the fork point) and
   the convergence list (who conflicts with whom, what is ready) before Land. Usage moves
   into Settings.

**D — Polish**
9. Tabs reachable by keyboard (roving tabindex, ←/→); Layouts and colour menus close on
   Esc / outside click; text labels instead of emoji/arrow glyphs; "guarded/advisory"
   instead of T2/T3 in the rail; sessions no longer all auto-open as tabs.
10. Gateway web client: xterm served by the gateway itself, not a CDN.
11. Known limitations + digest line.

Gate per task: `bun run typecheck` · `bun test --max-concurrency=1` · `bun run build`;
cockpit tasks add `cd apps/cockpit && bun test && bun run build` and a CDP look.
