# Session panel overview — known limitations

Design: `docs/superpowers/specs/2026-10-09-session-panel-overview-design.md`.

- The rail only has a panel inventory for live project views. A project evicted by the six-view cap shows its session rows without panel chips until its view becomes live again.
- Browser panes are project-scoped and have no session owner, so they do not appear under a session.
- A panel can close after the rail report is rendered. Selecting that stale entry is a no-op; the next report removes it.
- Expanded panel lists are in-memory window state and reset when the Cockpit window restarts.
- A session with a single panel has no list; its row click opens that panel. A session whose only panel is a Terminal therefore shows no chip.
- Terminal numbers follow reading order, so closing `Terminal 1` renumbers the rest. The stage itself labels every terminal `name · terminal`, so the rail is the only place they are told apart.
- Choosing a panel hidden behind a zoomed sibling drops the zoom rather than moving it.
- The existing row chips (`land`, `conflict`, check) stop their click from opening the session but not Enter/Space; only the panel chip stops both. Left as is to keep this change scoped.
