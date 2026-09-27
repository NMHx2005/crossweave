# Cockpit phase B (notes, shortcuts, tmux-like panes) — Known Limitations

**Date:** 2026-09-27
**Plan:** `docs/superpowers/plans/2026-09-27-cockpit-roadmap.md` (Phase B)

## What is built

- **A note per session**, kept by the daemon (schema v13, `note` column): `session.note`
  RPC, `cw session note <name> "…"`, a NOTE column in `cw session list`, and in the rail
  the note replaces the agent's last words (right-click → Set / Edit / Clear note).
- **Rebindable shortcuts**: one command list (`apps/cockpit/src/lib/keymap.ts`) builds
  the menu; Settings → Keyboard records a new chord, unbinds, resets, and refuses to
  save two commands on one chord; the menu is rebuilt on Save. Help → Keyboard
  Shortcuts (⌘/) lists them.
- **tmux-like panes** (menu Pane, and the pane's right-click menu): zoom (⌘⇧↩), focus
  by direction (⌘⌥ arrows), equalize (⌘⌥=), layouts side by side / stacked / main
  left / tiled, swap with next, move to a new tab, and drag a pane by its grip onto
  another pane's side.

## Gaps

- **Layouts, swap, move and break-out rebuild the tab's tree**, so the terminals in it
  re-attach (a replay); zoom and focus moves do not.
- **Panes move within their tab only** (no dragging a pane into another tab).
- **Shortcuts are the menu's**: a command without a menu item cannot be bound, and
  shortcuts typed inside the in-app editor or a browser pane still reach the menu first.
- **The recorder takes one chord**, not sequences (no tmux-style prefix key).
- **A note is one line of 120 characters**, and only the cockpit and `cw session note`
  set it (the TUI shows none).
- **Downgrading** below schema v13 is refused by an older build, as for every migration.
