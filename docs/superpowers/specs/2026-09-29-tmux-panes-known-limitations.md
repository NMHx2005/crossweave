# tmux parity 2A — panes: known limitations

**Date:** 2026-09-29 · Design: `2026-09-29-cockpit-tmux-parity-design.md` · Branch `feat/tmux-panes`

## What shipped

- **Layout reducers in `src/core/layout/`** (pure, shared), re-exported by
  `apps/cockpit/src/lib/layout.ts`; the tests moved to `tests/core/layout.test.ts`.
- **Cross-tab move:** `movePaneToTab` / `joinPane` / `breakPane` (a pane is never lost, an empty tab
  collapses, focus follows). In the app: drag a pane's grip onto a tab (the tab is outlined while a
  pane is over it), or the pane's context menu → *Move to tab "…"*.
- **Synchronize panes:** `Tab.sync`, `syncTargets`, a banner naming how many panes get the typing
  with a *Turn off*, the *Pane → Synchronize Panes* command and a context-menu entry. Fan-out is from
  `onData` (so IME-composed Vietnamese works) with both report strips always on; `REPORT` now also
  covers DECRPM and XTVERSION.
- **Copy-mode:** `src/core/layout/copy-mode.ts`, a pure vi-style machine (`h j k l w b e 0 $ gg G { }`,
  `Ctrl-u/d/b/f`, `/ ? n N`, `v V y Y`, `q`, Esc), drawn in the pane with a status line and a
  highlighted cursor cell; yank goes to the clipboard. *Pane → Enter Copy Mode*.
- Verified on the real app: menu and drag moves between tabs; sync — one shell runs a command
  before sync, both after, and no terminal replies were copied; copy-mode — motions, yank of
  `beta two`, search jumping to `gamma`, `q` leaving, and no key reaching the shell.

## Limitations

- **Bracketed paste and cursor-key mode cannot be normalised by stripping.** A synchronized
  target whose modes differ from the source's (DECCKM, bracketed paste) can receive the wrong
  bytes for arrows or a paste. Per-target re-encoding would be a follow-up.
- **Sync is view state:** it is not saved, not restored, and is dropped when a stored stage loads.
  Only session and terminal panes take part; a browser, file or Changes pane is left out.
- **Copy-mode is approximate:** a cell is one string index (wide and combining characters are off by
  a column), a "word" is a fixed rule, and a selection across wrapped lines counts cells by the pane
  width. An agent on the **alternate screen has no scrollback** to browse (tmux is the same).
- **The native menu has no *Move Pane to Tab ▸* submenu:** tabs change at runtime, so the entry lives in
  the pane's context menu and in drag-and-drop. `copy-mode` and `sync-panes` have menu items but no
  default keys until the prefix table (2B).
- **Copy-mode reads the terminal's own buffer**, so text scrolled out of the (5000-line) scrollback is
  gone, and the visual selection is drawn with xterm's selection (one highlight at a time).
- **Yank uses `navigator.clipboard.writeText`**, which can be refused; a failure is silent.
