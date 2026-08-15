# M8 TUI Manual Smoke-Test Checklist

**Important:** This checklist covers every manual verification step from Tasks 3–8. None of these steps have yet been performed by anyone — no agent in this session had access to a real interactive TTY. Items checked with "✓" in this document are logical/source-verified only. The checklist below represents what remains genuinely unverified and requires human execution with a real terminal and workspace.

---

## Prerequisites

1. Clone/create a test workspace (or use the main `crossweave` repo if safe)
2. Start `cw daemon start` (or let it auto-start on first command)
3. Create 2+ sessions in the workspace (e.g., `cw session new alice`, `cw session new bob`)
4. If testing convergence matrix (Task 5): run at least one merge trial so there is pairwise status data
5. If testing collision radar (Task 6): open two sessions and edit the same symbol simultaneously in both to trigger a collision

---

## Section 1: Panes Display Real Data (Tasks 3–6)

### Session List Pane
- [ ] **Session names appear**: Run `cw tui`. Confirm the session list shows the names of your created sessions (e.g., `alice`, `bob`).
- [ ] **Session status dot correct**: Each session displays a dot (`●` for running/waiting, `○` for idle, `✕` for dead/landed). Confirm the dot matches the real status (if you killed a session, `✕` should appear; if a session has been quiet, `○` should show).
- [ ] **Enforcement tier shown**: Confirm the enforcement tier (e.g., `(safe)`, `(enforce)`) is rendered for each session.
- [ ] **Cost shown**: Confirm each session displays its accrued cost in USD.

### Status Bar (Task 4)
- [ ] **Workspace name correct**: The status bar header shows your workspace name.
- [ ] **Session count and grammar**: If 1 session, bar says `1 session`; if 2+, says `N sessions`. Plural is correct.
- [ ] **Total cost burn**: Status bar shows the sum of all session costs (e.g., `$X.XX total`).
- [ ] **Disk usage**: Status bar shows disk consumption in the format `disk X.XGB/Y.YGB`.

### Convergence Matrix (Task 5)
*(Only applicable if your workspace has a completed merge trial.)*

- [ ] **Matrix grid appears**: A text grid is visible with session names as both row and column headers.
- [ ] **Diagonal is dash**: The diagonal cells (`alice-alice`, `bob-bob`, etc.) all show `'—'` (no merge of a session with itself).
- [ ] **Pairwise results correct**: Cells show `'clean'` if the pair can land together without conflict, `'conflict'` if there was a git conflict, test failure, or unverified merge, `'?'` if no trial data exists, or `'—'` for same-session pairs.
- [ ] **Matrix is symmetric**: The value at `[row=alice, col=bob]` matches `[row=bob, col=alice]`.

### Radar Feed (Task 6)
- [ ] **Feed pane visible**: A `'Radar feed'` box is shown below the convergence matrix.
- [ ] **Events appear**: When collisions or other broadcast events occur, they appear as timestamped lines in the feed (e.g., `HH:MM:SS  crossweave: symbol collision detected`).
- [ ] **Newest at bottom**: New events are appended to the bottom; the feed scrolls to show the newest.
- [ ] **Throttling preserved**: Multiple rapid events of the same type are throttled (as per `src/notify/dispatcher.ts`'s `NotificationGate`); only one instance appears in the feed per throttle window.

---

## Section 2: Keyboard Actions (Task 7)

### Key: `n` (New Session)
- [ ] **Form appears**: Press `n` with a session selected. A form pops up asking for session name and agent.
- [ ] **Name field focused first**: The cursor is in the name field by default.
- [ ] **Tab/Enter moves to agent**: Press Enter; focus moves to the agent field (default value is `claude`).
- [ ] **Escape cancels**: Press Escape in either field. The form closes without creating a session.
- [ ] **Enter creates session**: In the agent field, enter a valid agent name (e.g., `claude`) and press Enter. The new session is created; the form closes.
- [ ] **Typed characters reach form**: While in the name/agent fields, typed characters (including letters that are also keybindings: `l`, `x`, `n`, `g`, `q`) are sent to the input field, not interpreted as commands.
- [ ] **Invalid input rejected**: If name or agent field is empty, press Enter; a status message appears (e.g., `name required`), and the form stays open. Try entering a valid name and proceeding.

### Key: `l` (Land Selected Session)
- [ ] **Land works**: Select a session (use arrow keys) and press `l`. The session lands (status should change to `landed` or similar). A message like `landed <name>` appears on the action-status line.
- [ ] **No session selected**: Press `l` with no session selected (e.g., focus lost). A message like `no session selected` appears.
- [ ] **Error reported**: If land fails (e.g., session already landed, workspace deleted), the error message appears on the status line.

### Key: `shift+l` (Land All in Order)
- [ ] **Multiple lands in sequence**: Press `shift+l`. The TUI lands all conflict-free sessions in topological order (via the convergence matrix). A message like `landed alice, bob, charlie` appears.
- [ ] **Stops at first failure**: If one session fails to land, the message shows which sessions landed and which one it stopped at (e.g., `landed alice, bob; failed at charlie: <reason>`).
- [ ] **All success case**: If all sessions land, the message lists all of them and no `failed at` clause.

### Key: `x` (Kill Selected Session)
- [ ] **`x`, not `k`**: rebound in the final-review fix wave — `@opentui/core`'s `SelectRenderable` ships its own default `k` → move-up binding (alongside `j` → move-down), which the old `k` kill binding silently shadowed (vim-style "move up" never worked; `k` opened a kill confirm instead, risking an accidental kill from reflexive `y` muscle memory). Confirm arrow-key/`j`/`k` navigation all move the selection normally, with `k` moving up (not opening a confirm).
- [ ] **Confirm prompt appears**: Press `x` with a session selected. The status line changes to `kill <name>? (y/n)`.
- [ ] **y confirms**: Press `y`. The session is killed; status changes to `killed <name>`.
- [ ] **Any other key cancels**: Press `x`, then press `n` (or any key except `y`, including `q`). The prompt disappears; the session is **not** killed (and the TUI does **not** quit).
- [ ] **Other keybindings blocked during confirm**: Press `x` for a confirm, then quickly press `n` (new session), `l` (land), `g` (gc), or `q` (quit). The confirm prompt stays and waits for `y`/`n`; the other key does **not** fire until the confirm is answered. (This was the race-condition bug found in Task 7's review; `q` joined this same protection in the final-review fix wave — see the Quit section below.)

### Key: `g` (Garbage Collection)
- [ ] **Confirm prompt appears**: Press `g`. The status line changes to `run gc? (y/n)`.
- [ ] **y confirms**: Press `y`. Garbage collection runs (old worktrees deleted); status changes to `gc complete`.
- [ ] **Any other key cancels**: Press `g`, then press `n`. The prompt disappears; gc does **not** run.
- [ ] **Confirm blocks other keys**: Same as `x` — pressing `g` for confirm, then `l` quickly should **not** land a session until you answer the `y`/`n` prompt.
- [ ] **Dashboard refreshes after gc**: After a `g` gc completes, the session list, convergence matrix, and disk figure in the status bar all update to reflect anything gc removed — no manual refresh or restart needed.

---

## Section 3: Attach/Detach Round-Trip (Task 8)

### Source Mode Attach
- [ ] **Run from source**: Start the TUI via `bun src/cli/index.ts tui`.
- [ ] **Select and attach**: Select a session, press Enter. The TUI panes disappear; the attached session's live output appears.
- [ ] **Scrollback replayed**: Old content from the session (if any) is visible first.
- [ ] **Live output flows**: New output from the attached session appears in real time.
- [ ] **Ctrl+] detaches**: Press `Ctrl+]` to detach. The terminal returns to the TUI; all panes are re-populated with current data (session list, status bar, feed may have new events).
- [ ] **Terminal state intact**: After detach, the terminal is in a normal state (echo on, raw mode off, cursor visible).

### Compiled Binary Mode Attach
- [ ] **Build the binary**: Run `bun run scripts/build.ts` to generate `dist/cw`.
- [ ] **Run from binary**: Start the TUI via `./dist/cw tui`.
- [ ] **Attach and detach**: Repeat the source mode steps above using the compiled binary. Confirm attach, scrollback, live output, and detach all work.
- [ ] **Binary path resolution correct**: Whether you invoked `./dist/cw` (relative) or `/full/path/to/dist/cw` (absolute) or from a different working directory, the child `cw session attach` process is launched with the correct binary path.

### Killed Attached Process
- [ ] **Attach to a session**: Press Enter on a session in the TUI. The TUI suspends and attaches.
- [ ] **Kill the session from another terminal**: Open a second terminal and run `cw session kill <name>`.
- [ ] **TUI recovers**: The attach child process exits. The TUI's `renderer.resume()` fires (in the `finally` block), and the terminal is restored. The panes reappear; no hang, no corruption.

---

## Section 4: Graceful Exit and Resize (Tasks 3, 9)

### Quit Command: `q`
- [ ] **q exits cleanly**: Run `cw tui`, then press `q`. The TUI exits; the shell prompt returns.
- [ ] **Terminal restored**: After quitting, the terminal is in normal mode (raw mode off, alternate screen gone, echo on).
- [ ] **Daemon connection closed**: No orphaned daemon processes are left behind.
- [ ] **q does not fire on ordinary text** (Critical 1 fix): `q` is now part of the same focus-scoped action layer as `n`/`l`/`shift+l`/`x`/`g`, not a separate global raw listener. Press `n` to open the new-session form and type a name containing "q" (e.g. `query-api`) into the name/agent fields — the TUI must **not** quit; the letter reaches the input field like any other. Escape out of the form afterward.
- [ ] **q does not fire during a confirm**: Press `x` (or `g`) to open a y/n confirm, then press `q`. The confirm must be **cancelled** (same as any non-`y` key), and the TUI must **not** quit. Quit only fires on the next `q` press after the confirm is answered.

### Terminal Resize
- [ ] **Resize while TUI is running**: Run `cw tui`, then resize the terminal window (e.g., drag the terminal window corner or use `stty rows N cols M`).
- [ ] **Layout reflows**: The panes reflow to fit the new terminal size. No content is lost; panes shrink/grow as needed.
- [ ] **No corruption**: The text and boxes are still aligned correctly; no garbled characters or misaligned borders.
- [ ] **Scrolling still works**: If a pane (e.g., radar feed) is scrollable and was scrolled partway, resizing does not corrupt the scroll position or cause the pane to blank out.
- [ ] **Spec §6 open question**: The design spec (§6) flagged an open question about `renderer.resize()` — confirm the resize event is triggered and handled correctly by OpenTUI's internal machinery (via the terminal-size-change signal), not via an explicit `renderer.resize()` call in our code.

---

## Section 5: Signal Handling (Tasks 3, 7, 9)

- [ ] **SIGINT (Ctrl+C)**: Press Ctrl+C while in the TUI. The TUI exits cleanly (via the renderer's own signal handler, not our code). Terminal is restored.
- [ ] **SIGTERM**: From another terminal, send `SIGTERM` to the TUI process (e.g., `kill -TERM <pid>`). The TUI exits; terminal is restored.
- [ ] **No orphaned daemons**: After any signal-driven exit, no daemon processes remain.

---

## Section 6: Edge Cases and Error Handling

- [ ] **No sessions yet**: Create a workspace and run `cw tui` without creating any sessions. The session list is empty; status bar shows `0 sessions`. Other panes show appropriate empty states.
- [ ] **Session list changes mid-run**: In the TUI, open a second terminal and run `cw session new other`. The session list in the TUI updates within a few seconds (via `tui.invalidate` broadcast).
- [ ] **Workspace deleted mid-run**: In a second terminal, run `cw workspace delete <current-workspace-name>` while the TUI is open. The TUI catches the error (e.g., workspace not found on next refresh) and reports it on the status line; does not crash.
- [ ] **Daemon dies mid-run** (corrected in the final-review fix wave — the item previously here claimed an automatic reconnect that does not exist in this codebase): Stop the daemon from another terminal (`cw daemon stop`, or kill it). There is **no** automatic reconnect or daemon re-launch. The action-status line shows `daemon connection lost — press q to exit` (via `conn.onClose`) as soon as the connection drops. Any action attempted afterward (`l`, `x`, `g`, etc.) fails fast with its own error on the status line, same as any other RPC failure. Panes stop updating (no more `tui.invalidate`/`tui.event` can arrive). Does not hang. The user must press `q` to quit and re-run `cw tui` to reconnect — `cw tui` itself has no retry loop.

---

## Verification Status

- **All items above**: NOT YET PERFORMED. No agent in this session had a real interactive TTY.
- **Tests passing**: `bun run typecheck` (0 errors) and `bun test` (full suite green) have been verified non-interactively.
- **Source-code verification**: The underlying code (suspend/resume, terminal restoration, signal handling) has been verified by reading the source of `@opentui/core`, not by live execution.
- **Flagged library bugs found by source-reading**: Two real bugs in Task 7 (missing keymap binding parser, `'L'` vs `'shift+l'`) were found and fixed by reading bundled source, not by running the code. This demonstrates the value of deep reading but also the limit of non-interactive verification — only a real terminal can catch races and UI state issues.

---

## How to Run This Checklist

1. **Environment**: Use a real terminal (not a PTY relay or non-TTY pipe).
2. **Workspace**: Use a test workspace with 2+ real sessions and (for Tasks 5–6) a completed merge trial and a collision trigger.
3. **Both modes**: Test from source (`bun src/cli/index.ts tui`) and from the compiled binary (`./dist/cw tui`).
4. **Record findings**: For each section, note whether all checks passed, or document any failures (error messages, unexpected behavior, terminal state issues).
5. **Signal any gaps**: If any item cannot be tested (e.g., no workspace available, no merge trial data), note it in the report.

---

## Related Documents

- **Task 3 report** (`.superpowers/sdd/2026-08-15-m8-tui-dashboard/task-3-report.md`): Terminal restoration fix and keypress event pipeline.
- **Task 4 report** (Task 4): Session list and status bar formatting.
- **Task 5 report** (Task 5): Convergence matrix pane.
- **Task 6 report** (Task 6): Radar feed live updates.
- **Task 7 report** (Task 7): Keymap actions, confirm prompts, and the keymap-race fix.
- **Task 8 report** (Task 8): Attach/detach round-trip, self-invocation resolution.
- **Design spec** (`docs/superpowers/specs/2026-08-15-m8-tui-design.md`): High-level design, layout, and constraints.
