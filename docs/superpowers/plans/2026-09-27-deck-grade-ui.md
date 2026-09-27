# Plan — A Deck-grade cockpit: status you can read at a glance, many projects, quiet chrome

**Ask (2026-09-27):** compared with SpaceVibe Deck the cockpit is hard to use and looks
worse. Do all five points: (1) know again what a session is doing — without choosing
an AI; (2) a rail whose rows say what is happening; (3) several projects in one window;
(4) Deck-like chrome; (5) keep Land / Changes / ⌘K but put them where they are seen.
**Tier:** Large — daemon status inference, a multi-daemon bridge, the cockpit's layout.
**Branch:** `feat/deck-grade-ui`.
**Status:** done (2026-09-27), phases A–D. Gaps: `2026-09-27-deck-grade-ui-known-limitations.md`.

## Decisions

- **Status is inferred, never configured.** The daemon watches each session's shell:
  - *agent* — the first known agent CLI among the shell's descendant processes
    (`claude`, `codex`, `opencode`, `gemini`, `agy`/`antigravity`, `cursor-agent`),
    found with one `ps` sweep for all sessions; a `cx` wrapper that ends up running
    `claude` reads as Claude.
  - *activity* — `working` while the pty produced output in the last few seconds (agent
    TUIs animate while they think); `asked` when output stopped after work and either the
    terminal rang the bell or the agent's own log ends on its reply; `idle` otherwise;
    `failed` when the shell exited non-zero on its own.
  - *last activity time* — the last output or input.
  These ride on `session.list`; a change of activity broadcasts `tui.invalidate`
  (debounced), so every client redraws without polling.
- **Many projects, one window.** The bridge keeps one daemon connection per open
  project; one project is *active* (its tabs are on the stage, every existing channel
  targets it). The rail lists every open project with its sessions, summarised from
  each daemon's `session.list`; choosing a session in another project makes that project
  active and restores its tabs. Open projects persist per window in userData.
- **Chrome**: hidden-inset title bar, traffic lights inside the sidebar; "+ New" and a
  sidebar toggle at the top; tabs with a kind icon, the session's latest words as title,
  and a `+`; no per-pane title bar (split/close move to ⌘D, ⌘⇧D, ⌘W and a context menu);
  larger type; no footer (land results become a transient toast).
- **Land where it is seen**: a ready session's row carries a Land action; conflicts
  show on the row; the Changes pane opens from the row and from the right-hand toggle.

## Phases

**A — Status inference (daemon)**: activity tracker in the runtime, process-tree agent
detection, `session.list` fields, debounced invalidation. Tests with a fake clock and a
fake `ps`.
**B — Multi-project bridge**: open projects list, per-root connections, `projects.*`
channels, events tagged by root, active-project switching.
**C — Rail and chrome**: project groups, Deck-style rows, hidden titlebar, tab icons and
titles, pane chrome removed, shortcuts, toast, typography.
**D — Land/Changes surfacing, docs**: row actions, right toggle, known limitations.

Gate per phase: `bun run typecheck` · `bun test --max-concurrency=1` · `bun run build`;
cockpit phases add `cd apps/cockpit && bun test && bun run build` and a CDP look.
