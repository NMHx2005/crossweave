# Plan — Deck parity (daily use + layout)

**Ask (2026-09-26):** close the gaps against SpaceVibe Deck, items 1–10; release work
(signing, notarization, installer, updater) comes last, separately.
**Tier:** Large — agent catalog, resume, user settings, new RPCs, cockpit layout rewrite.
**Branch:** `feat/deck-parity`, one commit per task, reported per phase.

## Decisions (asked, answered)

- New agents launch in their **normal, asking mode** (`codex`, `opencode`, `gemini`,
  `agy`); bypass flags are the user's edit in Settings.
- Settings are **per user** (`~/.crossweave/settings.json`), never per repo: a cloned repo
  must not be able to declare commands the daemon runs.
- Stage becomes **tabs + split panes** (resizable, named layouts), replacing the 4-grid.
- In-app editing uses **CodeMirror 6**; reads/writes go through the daemon, contained
  to the session's worktree.
- The sandbox's **network is on by default**: with it off no agent could reach its model
  API (measured: `HTTP=000` to api.anthropic.com from a sandboxed session). The sandbox
  keeps confining writes.

## Phases

**A — Engine**
1. Sandbox network on by default.
2. Agent catalog (built-ins: claude T2; codex, opencode, gemini, antigravity T3 advisory;
   plus user-declared commands) in user settings; `agents.list`, `settings.get/set`.
   Each built-in declares the state dirs the sandbox must let it write (`~/.codex`, …).
3. Resume: a session started before resumes its own conversation, found by the
   session's worktree path — Claude `--resume <id>` (project dir name = realpath with
   every non-alphanumeric → `-`), Codex `codex resume <id>` (`session_meta.cwd`),
   OpenCode `--session <id>` (`session list --format json`, `directory`). Others relaunch.
4. Latest words: the last assistant text from the agent's own log (Claude, Codex),
   surfaced as `latestWords` in `session.list`; others fall back to nothing.

**B — Daily-use UI**
5. Quick picker (⌘T): agent + session name, replacing the two `window.prompt`s.
6. ⌘⇧A jumps to the pane that most needs attention; rail shows latest words.
7. Cmd+click on `path[:line[:col]]` opens the configured editor (main process, argv,
   path contained in the worktree).

**C — Layout**
8. Tabs (drag to reorder, pin, close / close others / close to the right) holding a
   split tree (horizontal/vertical, drag to resize), named layouts saved per user.

**D — Surfaces**
9. File pane (CodeMirror; `workspace.readFile/writeFile` contained), browser pane
   (isolated `<webview>`: no node, own partition), worktree picker + worktree colors.

**E — Settings page**
10. Enable/disable agents, edit launch commands, add custom agents, choose the editor.

## Gate (every phase)

`bun run typecheck` · `bun test --max-concurrency=1` · `bun run build` · cockpit
`bun run build` + tests + a look at the running app.
