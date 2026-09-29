# tmux parity 2B.1 — command registry: known limitations

**Date:** 2026-09-29 · Design: `2026-09-29-cockpit-tmux-parity-design.md` · Plan: `../plans/2026-09-29-cockpit-tmux-parity.md` · Branch `feat/command-registry`

## What shipped

- A command may have **no menu item** (`menu: null` in `keymap.ts`): it is listed under "Other" in
  Settings → Keyboard, can be bound like any command (conflicts are checked the same way), and runs
  from the user's own shortcut, which the window listens for in the capture phase
  (`menuLessBindings` + `keyMatchesAccelerator`), so a focused terminal does not swallow it.
  Commands with a menu item keep their accelerator in the menu, which still wins over a terminal.
- New commands: **Next Tab / Previous Tab** (⌘⇧] / ⌘⇧[, in the Session menu), and **Cycle Pane
  Layout** (no menu item, no default key: tmux's `Space`), backed by the pure reducers `adjacentTab`
  and `cyclePreset`.
- Verified on the real app: with `cycle-layout` bound to ⌘⌥Space in settings, a real key event
  cycles two panes from side by side to stacked, and no pane is lost.

## Limitations

- **macOS only:** `CmdOrCtrl` is matched as ⌘ (the cockpit is macOS-only).
- **A menu-less binding needs a modifier** (the accelerator grammar refuses a bare letter, which
  would steal typing from every terminal). The tmux prefix sequences arrive with 2B.
- **The "registry" is the command list plus the handler cases in `ProjectView`**, not a separate
  object: the plan's "handlers" are added where the existing commands' handlers already live.
- **`cyclePreset` continues from the preset last applied to the tab**, kept on the tab (not saved
  with a layout); after a manual split the next cycle continues from that memory, not from what is drawn.
- `copy-mode` and `sync-panes` are added to the registry with 2A, when their handlers exist.
- The menu-less listener ignores repeats and IME composition, and does not run for a bare modifier.
