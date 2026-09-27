# Live projects — every open project keeps its panes

**Date:** 2026-09-27
**Status:** Implemented (2026-09-27)
**Scope:** Cockpit (renderer + Electron bridge). The daemon is unchanged.

## Problem

Switching project in the cockpit reloads the whole window (`switchProject` →
`workspace.ensure` → `location.reload()`). Nothing is stopped — each project's daemon
keeps its shells, measured 2026-09-27: a loop in project B kept writing while A was on
the stage — but the window rebuilds from nothing: the rail, every tab, every terminal
re-attaches and replays, settings and every other project are re-read. It reads as the
app jolting, and as the other project's work having been cut off.

The user's model, stated: every project runs at the same time, each works through what
it was given and stops when done; looking at one project must never interrupt another
(as in Cursor with several windows, but in one window).

## Decision (user's choice, 2026-09-27)

**Keep every visited project alive in the window.** A project's tabs, splits and
terminals stay mounted after the user leaves it; switching hides one and shows the
other, instantly, with terminals still streaming. Rejected: swapping the stage in place
(no reload, but the other project's terminals would still re-attach on every return).

## Design

### 1. Bridge: every open project is addressable, and every project speaks

- **Routing.** Any daemon RPC may carry `projectRoot`; if it names a project open in
  this window, the call goes to that project's daemon, else it is refused. Today only
  four channels route (`session.rename`, `workspace.gc`, `converge.status`,
  `land.session`); this becomes all RPC channels. The active project stays the default
  when `projectRoot` is absent, so the CLI-shaped calls keep working.
- **Notifications.** `session.data`, `session.exit`, `terminal.data`, `terminal.exit`,
  `tui.invalidate`, `tui.event` and `daemon.gone` are forwarded from **every** attached
  project, each payload tagged with `projectRoot`. `project.invalidate` goes away (it was
  the stand-in for "a project not on the stage changed"). Output still flows only for
  sessions some pane attached to — the daemon subscribes per `session.attach` — so a
  project with no panes costs nothing on the IPC.
- **Active** remains a bridge concept only for defaults (`saveRoot`, the no-root
  calls, `editor.open`). Switching the stage calls `workspace.ensure` for that root,
  never reloads.

### 2. Renderer: one view per project

- `App` becomes the **host**: sidebar, welcome, global dialogs (Settings, Project
  settings, confirm), the toast, the Dock badge, and which project is on the stage.
- `ProjectView` (new) holds everything that is per project today inside `App`:
  sessions, stage (tabs/splits), converge verdicts, colors, layouts, the ⌘T picker's
  create, the command bar, quick open, land. One is mounted per **visited** open
  project; all but the active one are `display: none`. Menu accelerators go to the
  active view through a registered handle.
- **A project-bound API.** `projectApi(root)` returns `cockpitApi`'s shape with
  `projectRoot` added to every call and event filter. A Preact context provides it, so
  `pane-source`, `XtermPane`, `FilePane` and `ChangesPane` stop importing the global
  `cockpitApi`. Session and terminal ids are ULIDs, unique across projects, so pane
  event filters stay id-based; `projectRoot` on events decides which view refreshes on
  `tui.invalidate`.
- **The rail** reads mounted views' live state (each view reports its sessions and
  attention up); projects never visited this window keep today's snapshots.
- **Hidden panes stay correct.** xterm refits through its ResizeObserver when a view is
  shown again (0×0 → real size); a hidden pane skips its resize RPC while 0×0 so the
  shell is not told its terminal became zero columns.

### 3. Memory bound

Each mounted xterm keeps its scrollback. A cap of **6 mounted views**, least recently
shown unmounted first (its shells keep running in the daemon; returning re-attaches, as
today). Pure LRU function, tested.

## What does not change

- The daemon, its RPCs, the database. Shells were never tied to the window.
- Opening a project from the menu, Open Recent or `cw` (a second instance) — those still
  go through `workspace.ensure`; only the reload after it goes.

## Risks

- `App.tsx` (~1300 lines) is split in two; every per-project handler moves. Mitigation:
  move code as is, bind it to the view's API, and keep behaviour tests green at each step.
- More IPC when several projects stream at once — bounded by attached panes, and by the
  view cap.
- A view hidden for long accumulates output in xterm (its scrollback limit applies).
