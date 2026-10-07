# Roadmap follow-through Implementation Plan

> **For agentic workers:** Execute inline in the current session; this plan is a record of the live work.

**Goal:** Close the session hook routing gap and deliver the approved usability and stability follow-through.

**Spec:** `docs/superpowers/specs/2026-10-07-session-status-provenance-design.md` plus the adjacent session-hook design.

## Tasks

- [x] Fix session shell context routing and verify `cw notify` in a disposable live Cockpit session.
- [x] Add tested status provenance and event age to the Cockpit row tooltip.
- [x] Expand README quickstart with a two-session workflow using existing commands.
- [x] Run Cockpit and repository gates sequentially; inspect the scratch UI and update known limitations with any remaining live-check gaps.
- [x] Stop the disposable daemon and Electron app; review the worktree diff.

Live checks completed 2026-10-08: a composer send populated Responses, and a Read-enabled localhost fixture's console error and failed request appeared in Debug. Agent access was restored to Off before closing the Browser pane. Real-world capacity still awaits owner usage.
