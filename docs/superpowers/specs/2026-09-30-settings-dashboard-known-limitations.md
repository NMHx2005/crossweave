# Settings redesign and Dashboard — known limitations

## What shipped

- Settings re-laid out after Cursor's: grouped icon navigation, a centred column, rounded cards of rows (words left, control right),
  real `role="switch"` toggles, a dismissible banner. Labels, descriptions, search and deep links still come from one registry.
- Settings → Dashboard: per project the sessions by state, worktree disk, daemon memory and the app's own memory; two charts (each with a
  table view); a sortable session list; **suggestions** — clean up ended sessions, delete a long-idle empty session (≥ 5 MiB), land-or-delete
  a long-idle session that still holds unlanded work, stop an idle agentless shell. Every action asks first and names what is lost.
- Daemon: `DiskTracker` measures worktrees off the event loop; `stats.overview` serves the figures; `workspace.info` uses the tracker too.
- The rail's filter box reads "Search" with an icon; the "No open tabs" box no longer touches the pane edges.

## Limitations

- **An old daemon has no `stats.overview`.** Its project shows "restart its daemon to see its numbers"; restarting ends its running sessions.
- **Disk figures are measured in the background** and are lower bounds (`≥`) when a walk hits its deadline or meets an unreadable folder;
  the page polls up to 40 times (2 s apart) and then stops until Refresh.
- **Delete and clean-up only propose.** Clean-up uses `workspace.gc`, which keeps a killed session with unlanded commits *or uncommitted
  files*; the suggestion excludes those and any session whose counts are unknown, so it never promises what gc would refuse.
- **Dropped from the design:** a "stop the daemon / close project" suggestion — closing a project does not stop its daemon and the window
  restarts daemons on demand, so it would not free anything reliably.
- Per-day charts use UTC days and the last 14 only; tokens and cost are not shown on the dashboard.
- Thresholds (7 / 14 days, 24 h, 5 MiB) are constants, not settings.
- `apps/cockpit/scripts/dashboard-check.ts` is destructive and needs a scratch repo and HOME; it is not part of the gate.
