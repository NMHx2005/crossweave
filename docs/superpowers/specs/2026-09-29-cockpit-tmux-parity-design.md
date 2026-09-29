# Cockpit tmux parity — the advantages of tmux, owned

**Date:** 2026-09-29
**Status:** Planned
**Scope:** `src/core/layout` (new, shared pure reducers), `apps/cockpit/src/lib`,
`apps/cockpit/src/ui`, `src/daemon` (terminal persistence, pane-command bridge, RPC),
`src/cli` (`cw pane`), `src/db` (schema for terminal persistence only).
**Branch:** one per sub-phase: `feat/command-registry` (2B.1), `feat/tmux-panes` (2A),
`feat/tmux-keytable` (2B), `feat/terminal-persist` (2C), `feat/pane-bridge` (2D).

## Problem

The cockpit already has the tmux vocabulary a person touches first: split panes, zoom
(`⌘⇧↩`), focus by direction (`⌘⌥←↑→`), layouts, swap, break-pane, drag by a grip
(`apps/cockpit/src/lib/layout.ts`). The gaps that keep it *not tmux*:

1. **No prefix key sequences.** Shortcuts are one Electron accelerator each
   (`apps/cockpit/src/lib/keymap.ts`); there is no `Ctrl-a` then key.
2. **Panes move within their tab only** — no join/break across tabs.
3. **Terminals are ephemeral** — in the daemon's memory, gone on restart
   (`src/daemon/terminals.ts:42`).
4. **No `synchronize-panes`.**
5. **No copy-mode** (keyboard selection/scrollback with vi keys); only `⌘F` search.
6. **No scripting/control surface for panes.** Layout lives in the renderer
   (`apps/cockpit/src/ui/storage.ts`, saved layouts in `~/.crossweave/settings.json`), so
   the CLI cannot drive panes.

## Decisions already taken

- **Persistence = respawn + snapshot** (user, 2026-09-29). No pty supervisor; the
  process does not survive a daemon restart, the shell is reopened and the scrollback
  restored.
- **Pane control = an incremental bridge** (user, 2026-09-29, after external review —
  reverses the earlier "layout to daemon"). `cw pane` → daemon → the running cockpit.
  No schema, no migration, layout stays client-side. **Daemon-owned layout is deferred**
  until there is a second client (the native iOS app).
- **Layout reducers live in `src/core/layout`** from sub-phase 2A (shared pure code;
  the cockpit already imports pure `src/` modules — `XtermPane.tsx:11-12`). `layout.ts`
  imports nothing, so this is a near-mechanical move and is what makes the deferred
  daemon-owned layout cheap.
- **Prefix = `Ctrl-a`, rebindable** (user, 2026-09-29).

## Sub-phase 2A — panes

All new reducers in **`src/core/layout/`** (pure, shared), re-exported by
`apps/cockpit/src/lib/layout.ts` so the UI is unchanged.

- **Cross-tab move.** `movePaneToTab(state, from, toTabId, index?)` and
  `joinPane`/`breakPane`; tests (a pane never lost, empty tab collapses, focus follows,
  idempotent on self). UI: drag the grip onto a tab in the tab strip; Pane → Move to
  Tab ▸.
- **`synchronize-panes`.** A per-tab `sync` flag (view state, not saved). The fan-out
  source is `term.onData` — **not `onKey`**, which does not fire for IME-composed text and
  would drop characters (the user types Vietnamese with Telex). But `onData` also carries
  xterm's own answers to the *program's* queries (device attributes, cursor position,
  focus), which a live agent needs, so the existing guard only strips them during replay
  (`XtermPane.tsx:141-142`). The **fan-out copy** therefore runs **both
  `stripFocusReports` and `stripTerminalReports` unconditionally**, and `REPORT` is
  extended to the gaps — DECRPM (`CSI ? Ps ; Pm $ y`) and DCS/XTVERSION (`DCS >| … ST`);
  it already covers DA, CPR and OSC colour replies (`src/client/terminal-reports.ts`). A
  pane not running shows the "not running" notice once, not N times. **Two encodings
  cannot be normalised by stripping** — bracketed paste (`ESC[200~`, on only in the source
  pane) and cursor-key mode (`ESC O A` vs `ESC [ A`, per-pane DECCKM) — so a target with
  different modes can receive the wrong bytes; documented in the known-limitations file
  (per-target re-encoding is a possible follow-up). Pure `syncTargets(tab)` + tests; a
  dismissible banner naming the N panes.
- **Copy-mode.** `src/core/layout/copy-mode.ts`, a pure state machine: motions
  `h j k l w b e 0 $ gg G { } Ctrl-u Ctrl-d Ctrl-b Ctrl-f`, `/`/`?` search via
  `SearchAddon`, `v`/`V` visual, `y` yank, `q`/Esc exit. The pane shows a mode line and a
  block cursor; selection via `term.select`/`term.getSelection`. Until the key-table
  lands (2B) it is reachable through a **Pane → Enter Copy Mode** command in the 2B.1
  registry. Known limitation: an agent on the alternate screen has no scrollback to browse
  (tmux is the same); `w/b/e` word definition and wide chars/wrapped lines are
  approximate.

## Sub-phase 2B — keyboard

- **Command registry first (2B.1).** `COMMANDS` already lives in the renderer
  (`keymap.ts:16`) and the Electron menu only imports it (`app-menu.ts:3`), so this is not
  moving a module: it is adding **handlers** plus commands that have **no menu item**, with
  one view of the registry for the menu. This removes the Phase-B limitation "a command
  without a menu item cannot be bound" and is the prerequisite for the key-table. 2B.1
  lands before 2A's menu items.
- **Key-table / prefix (2B).** `apps/cockpit/src/lib/keytable.ts`: modes `root` and
  `prefix`. The prefix chord (default `Ctrl-a`, rebindable, validated by the existing
  accelerator grammar) enters `prefix`; the next key resolves against a table (`%` split
  right, `"` split down, `z` zoom, arrows focus, `o` swap, `x` close, `[` copy-mode, `c`
  new tab, `n`/`p` tab nav, `Space` cycle preset, `:` command prompt, `?` list bindings).
  Prefix twice sends a literal prefix (tested). A transient hint overlay shows the
  bindings; `Esc` or a timeout leaves `prefix`.
  - **Interception is scoped to a focused terminal pane only** — never while the find box,
    Settings, a note editor or any input has focus, or `Ctrl-a` (beginning-of-line) breaks
    everywhere.
  - Match on `event.key` (so punctuation like `%`/`"` works per layout), handle
    **`isComposing`/IME** (the user types Vietnamese with Telex — a real case), ignore bare
    modifier keydowns.
- **Sequence recorder.** Settings → Keyboard records a 1- or 2-chord sequence in addition
  to today's single accelerator, with the same conflict check.

## Sub-phase 2C — terminal persistence

- **Opt-in, default off.** Snapshots are secrets at rest, so persistence ships **disabled**
  and is enabled per user in Settings (and named in `cw config`). With it off, terminals
  behave exactly as today (ephemeral).
- **Schema (forward-only).** A `terminal` table with what reopen needs: id (unchanged
  across restore), workspaceId, sessionId, createdAt, `snapshot` blob + `snapshotAt`.
  `argv`, `cwd` and `cols/rows` are **not** stored: `spawnShell` derives the shell and cwd
  from the session (`src/adapters/shell.ts`, `methods.ts:285`), and the size is set by the
  first client's fit (80×24 until then).
- **Write policy.** Snapshot on close and on daemon shutdown, plus a debounced periodic
  flush (start 30 s) while dirty — never per chunk.
- **Restore.** On daemon start, reopen each terminal whose session and worktree still
  exist, **keeping the same terminalId** (the cockpit's saved layout references it), mark
  it `restored`, replay the snapshot, then stream live. A pane whose session is gone is
  dropped. Terminals take no port/db/cache lease
  (`2026-09-26-terminal-pane-known-limitations.md`), so nothing is re-leased. The snapshot
  replay goes through the normal `subscribe()` path, so its stale device answers are
  suppressed by the same `replayAnsweredUntil` window — pinned by a test.
- **File permissions (verified 2026-09-29).** `.crossweave/` is `0700` (traversal is
  blocked), but `state.db` is `0644` and `journal.json` is `0644` — SQLite creates the file
  under the umask and only the socket is chmod'd (`daemon/server.ts:217`). Because a
  snapshot holds terminal output, when persistence is on the DB file is `chmod 0600` and
  the directory re-asserted `0700`; the exact current permissions are checked at
  implementation, not assumed.
- **Replay normalisation.** Snapshots are a raw VT tail and may be cut mid-escape or
  mid-UTF-8 and may carry alt-screen/SGR state. Restore resets (`\x1bc` + SGR reset)
  before replaying, and the snapshot is trimmed to a safe boundary; documented.
- **Deletion.** A terminal row is **deleted** on close, `gc`, `session rm`, session kill
  and `closeForSession` — not merely closed.
- **Honesty.** The UI says the shell is a new one; a daemon restart is not tmux's server
  survival. `terminal.list` carries `restored`.

## Sub-phase 2D — pane control bridge

The user reversed this from "layout to daemon" after review. Design (own spec + plan when
2C lands):

- **`cw pane …`** (`split`, `close`, `zoom`, `select`, `layout`, `move`, `sync`) calls the
  daemon; the daemon forwards the command to the cockpit attached to that workspace over
  the **shared command bridge** (`2026-09-29-cockpit-command-bridge-design.md`): request
  kinds `pane.*`, the bridge's correlation id, timeout, in-flight cap and typed errors —
  nothing is reinvented here. One cockpit per workspace, first registration holds the slot;
  no cockpit attached → `BRIDGE_NO_COCKPIT`.
- **Threat model.** `daemon.sock` is reachable by **any process running as the user**,
  including an AI agent inside a session, so the socket is not authentication and
  `CW_SESSION_ID` is spoofable and must not be used as identity. The bridge is the guard
  against a prompt-injected agent: a strict **allowlist** of pane commands, and
  `open --url` / `open --file` — which reach the cockpit's browser and file surfaces —
  require a **confirmation dialog in the cockpit** by default (not a silent open). The
  allowlist and per-pane-kind permissions get their own security review in 2D.
- **Layout stays client-side**; no schema, no migration.
- **Deferred:** daemon-owned layout (headless, multi-client) is written when the iOS app
  starts, as its own spec; the `src/core/layout` reducers make it cheap.

## Testing

- `tests/core/layout-*.test.ts` (moved from `apps/cockpit/tests/layout.test.ts`): cross-tab
  move, focus/collapse rules, sync targets, copy-mode.
- `apps/cockpit/tests/keytable.test.ts`, `keymap.test.ts` (sequences, IME, scope).
- `tests/daemon/terminal-persist.test.ts` (snapshot cap, stable id, restore when session
  exists, drop when gone, row deleted on close/gc, normalised replay, stale-DA suppression).
- 2D: `tests/daemon/pane-bridge.test.ts`, `tests/cli/pane.test.ts`.

## Ordering

2B.1 (registry) → 2A → 2B (key-table) → 2C → 2D. Each sub-phase ends with the full gate,
a known-limitations file + digest line, and a report before the next starts.

## Review revisions (2026-09-29)

Round 1: reducers moved to `src/core/layout`; registry ordered before 2A; persistence
security (opt-out, delete on gc/rm, normalised replay, stable id); **2D changed from
daemon-owned layout to an incremental bridge**.

Round 2: sync fan-out uses `onData` (not `onKey`, for IME) with **both strips
unconditional** and `REPORT` extended (DECRPM, DCS/XTVERSION); bracketed-paste/DECCKM
mismatches documented; copy-mode gets a temporary menu command; persistence **defaults
off**, drops the redundant `argv/cwd/cols` columns, and **hardens the DB file to 0600**
(the file is 0644 today, only the socket is chmod'd); the bridge grows a threat model
(socket is user-wide, `CW_SESSION_ID` spoofable, allowlist, confirmation for `open`).
