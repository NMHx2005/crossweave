# Plan — cockpit tmux parity

Spec: `docs/superpowers/specs/2026-09-29-cockpit-tmux-parity-design.md`
Branches: `feat/command-registry` (2B.1), `feat/tmux-panes` (2A), `feat/tmux-keytable`
(2B), `feat/terminal-persist` (2C), `feat/pane-bridge` (2D).
Tier: Large — panes, keyboard, daemon persistence, a control bridge.

Each sub-phase ends with the full gate, a known-limitations file + digest line, and a
report before the next starts. Order: **2B.1 → 2A → 2B → 2C → 2D**.

---

## 2B.1 — command registry first (`feat/command-registry`)

1. [x] Add handlers and a command **registry** in the renderer. `COMMANDS` already lives in
   `keymap.ts:16` and the menu only imports it (`app-menu.ts:3`), so this is adding
   **handlers** plus commands that have **no menu item**, and one view of the registry for
   the menu. Keep `keymap.test.ts` green; add a test that a menu-less command is runnable
   and bindable.
2. [x] Move the tmux table entries (`%`, `"`, `z`, arrows, `o`, `x`, `[`, `c`, `n`/`p`,
   `Space`, `:`, `?`) onto the registry.
3. [x] Gate + known limitations + digest line; report.

## 2A — panes (`feat/tmux-panes`)

1. [x] Move the layout reducers to **`src/core/layout/`** (pure; `layout.ts` imports
   nothing, so this is near-mechanical), re-exported by `apps/cockpit/src/lib/layout.ts`;
   port `layout.test.ts` to the core module and keep it green.
2. [x] `movePaneToTab`, `joinPane`, `breakPane` + tests (pane never lost, empty tab
   collapses, focus follows, idempotent on self).
3. [x] Stage/tab strip: drag a grip onto a tab to move the pane; Pane → Move to Tab ▸.
   CDP check.
4. [x] `Tab.sync` + `syncTargets(tab)` (pure, tested); fan-out from `onData` (not `onKey`,
   for IME) with **both strips run unconditionally** on the copy; **extend `REPORT`** with
   DECRPM and DCS/XTVERSION (`src/client/terminal-reports.ts`); "not running" shown once;
   bracketed-paste / DECCKM mismatches documented as a known limitation; dismissible
   banner naming the N panes.
5. [x] `src/core/layout/copy-mode.ts` state machine + tests (motions, visual, yank,
   search, exit); `XtermPane` intercepts keys while active, renders the mode line; yank via
   `navigator.clipboard`; reachable through a **Pane → Enter Copy Mode** menu command
   (until the key-table lands in 2B). Note the alt-screen limitation.
6. [x] Gate + known limitations + digest line; report.

## 2B — key-table (`feat/tmux-keytable`)

1. [x] `keytable.ts`: `root`/`prefix` modes, prefix chord (default `Ctrl-a`, rebindable,
   validated), table lookup, prefix-twice literal, hint overlay, `Esc`/timeout exit. Pure
   reducer tests + a DOM test that interception happens capture-phase **and only while a
   terminal pane is focused** (not the find box, Settings or a note).
2. [x] IME/repeat/layout handling (`event.key`, `isComposing`, bare modifiers); tests.
3. [x] Settings → Keyboard: record a 1- or 2-chord sequence; conflict detection across
   accelerators and sequences; reset.
4. [x] Wire the tmux table entries (from 2B.1) to the prefix.
5. [x] Gate + known limitations + digest line; report.

## 2C — terminal persistence (`feat/terminal-persist`)

1. [x] Settings: persistence **off by default** (opt-in); the daemon setting gates it.
2. [x] Migration: `terminal` table (id, workspaceId, sessionId, createdAt, snapshot,
   snapshotAt). Forward-only; repository + tests.
3. [x] `TerminalRegistry`: descriptors on open/close; debounced periodic snapshot (30 s)
   while dirty; snapshot on close and on daemon shutdown; cap; normalise the replay
   (`\x1bc` + SGR reset, safe trim).
4. [x] Restore on daemon start: reopen terminals whose session + worktree exist, **same
   terminalId**, mark `restored`, replay, stream; drop the rest. Row **deleted** on close,
   `gc`, session rm/kill, `closeForSession`. Test that a snapshot replay suppresses stale
   DA answers (`replayAnsweredUntil`). `tests/daemon/terminal-persist.test.ts`.
5. [x] Permissions: verify current dir/file modes, then `chmod 0700` the directory and
   `0600` `state.db` while persistence is on (the dir is already 0700; the file is 0644
   today).
6. [x] RPC: `terminal.list` carries `restored`; cockpit pane shows the restart note.
7. [x] Gate + known limitations + digest line; report.

## 2D — pane control bridge (`feat/pane-bridge`, own spec + plan)

1. [ ] Write `docs/superpowers/specs/<date>-pane-bridge-design.md` **on top of the
   shared command bridge** (`2026-09-29-cockpit-command-bridge-design.md`, which lands
   first): the `pane.*` kinds and the `cw pane` surface; a **threat model** (socket is user-wide,
   `CW_SESSION_ID` spoofable, strict allowlist, `open --url/--file` require a cockpit
   confirmation); the "no cockpit attached" error; its own security review.
2. [ ] Then its own plan. Not started until 2C has landed and been reported.
3. [ ] **Deferred:** daemon-owned layout (headless/multi-client) gets its own spec when
   the iOS app starts; the `src/core/layout` reducers make that cheap.

## Gate (every sub-phase)

`bun run typecheck` · `bun test --max-concurrency=1` · `bun run build` · cockpit
`bun test` + `bun run build` · a look at the running app (CDP/screenshot).
