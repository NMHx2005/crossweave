# Live projects — Known Limitations

**Date:** 2026-09-27
**Spec:** `docs/superpowers/specs/2026-09-27-live-projects-design.md`
**Plan:** `docs/superpowers/plans/2026-09-27-live-projects.md`

## What is built

- Every recently shown project keeps its view (tabs, splits, terminals) mounted;
  switching shows another view without reloading the window (~21 ms measured), and a
  hidden project's terminals keep streaming.
- The bridge routes any RPC that names an open project to that project's daemon, and
  forwards every project's notifications tagged with `projectRoot`
  (`project.invalidate` is gone; `daemon.gone` names its project).
- `projectApi(root)` binds calls and event filters to one project; panes take it from
  `ProjectApiContext`.
- Open Recent and a second `cw` launch show the project in the existing window instead
  of destroying and recreating it.

## Gaps

- **At most 6 projects keep live views** (`LIVE_VIEWS` in `App.tsx`). Past that, the
  project shown longest ago lets go of its panes; its shells keep running in its daemon
  and re-attach (with a replay) when it is shown again. Not configurable yet.
- **Hidden terminals keep their scrollback in memory** — RAM grows with the number of
  live views and panes; xterm's scrollback limit bounds each pane.
- **A tab not on screen inside a view is not live.** The stage renders its active tab
  only (as before), so switching tabs within a project still re-attaches that tab's
  panes; only switching projects is instant.
- **Only one confirm dialog at a time for the whole window**: a background project
  asking (land with incomplete evidence) waits behind one already open.
- **Toasts are window-wide**; a background project's are prefixed with its name, and a
  newer toast replaces an older one.
- **Settings are read through the project on the stage** (or the first open one);
  with no project open they cannot be opened.
