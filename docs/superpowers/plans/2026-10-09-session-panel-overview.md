# Session Panel Overview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person inspect and focus the open panels belonging to a session from the project rail.

**Architecture:** Derive session-owned panel summaries from each live project's existing `StageState`, carry them through `ViewReport` and `ProjectGroup`, and render them as an ephemeral disclosure beneath each session row. A new `focus-pane` view action routes a selected item back to its owning project; no daemon or database contract changes.

**Tech Stack:** Bun, TypeScript, Preact, CSS, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-10-09-session-panel-overview-design.md`

## Global Constraints

- Runtime: Bun ≥ 1.3.13, TypeScript, `bun:sqlite`, `bun test`, `bun build --compile`.
- Zero native modules; do not add dependencies.
- macOS and Linux only; the Cockpit remains macOS-only.
- Comments explain WHY, not WHAT; visible UI copy is English.
- Keep daemon ownership of persistent state; this feature adds no persisted state.
- Keep project status and active-project styling semantically separate.

---

### Task 1: Derive panel summaries from the stage

**Files:**
- Create: `apps/cockpit/src/lib/session-panels.ts`
- Test: `apps/cockpit/tests/session-panels.test.ts`

**Interfaces:**
- Consumes: `StageState`, `panesForSession`, and session ids/names.
- Produces: `sessionPanelsById(stage, sessions)` returning a record keyed by session id. Each entry contains ordered `{ tabId, paneId, kind, label, title? }` summaries for `session`, `terminal`, `file`, `changes`, and `debug` panes.

- [x] Write tests for stage-order grouping, multiple terminals, useful file labels, and omission of project-scoped Browser panes.
- [x] Run the focused test before implementation; it failed because the helper was missing.
- [x] Implement the pure summary helper using `panesForSession`; keep the full file path in a file panel's title and show its basename as the label.
- [x] Rerun the focused test and confirm it passes.

### Task 2: Carry panel summaries and route focus actions

**Files:**
- Modify: `apps/cockpit/src/ui/ProjectView.tsx`
- Modify: `apps/cockpit/src/ui/App.tsx`
- Test: `apps/cockpit/tests/session-panels.test.ts`

**Interfaces:**
- Consumes: `sessionPanelsById`, existing `ViewReport`, `ViewAction`, and `focusPane`.
- Produces: `ViewReport.panelsBySession`; `ViewAction` gains `{ kind: 'focus-pane'; tabId: string; paneId: string }`; App passes a `SessionPanel` selection to the live view or activates its project first.

- [x] Use the summary test to confirm every stage-owned pane keeps its `tabId` and `paneId` for exact selection.
- [x] Use the disclosure test to confirm the selected panel callback preserves those ids.
- [x] Report `panelsBySession` whenever stage or sessions change; forward it through `railGroups()`.
- [x] Handle `focus-pane` by applying `focusPane` to the current stage; route selections from inactive projects through the existing activation path. Ignore stale tab/pane reports safely.
- [x] Rerun the focused test and Cockpit typecheck/build to confirm the contract compiles.

### Task 3: Add the session disclosure to the rail

**Files:**
- Modify: `apps/cockpit/src/ui/Sidebar.tsx`
- Modify: `apps/cockpit/src/ui/app.css`
- Create: `apps/cockpit/tests/session-panel-disclosure.test.tsx`

**Interfaces:**
- Consumes: `ProjectGroup.panelsBySession` and `onFocusPanel(projectRoot, sessionId, panel)`.
- Produces: an accessible per-session disclosure with panel count and buttons that focus an exact panel.

- [x] Write component tests proving the disclosure reports the panel count, lists panel labels, invokes focus with the selected panel, and toggles through its handler.
- [x] Run the focused test before implementation and confirm it failed because the component was absent.
- [x] Add ephemeral expansion state to `Sidebar`; keep session-row selection separate from disclosure and panel selection.
- [x] Add a short height/opacity transition; rely on the existing global `prefers-reduced-motion: reduce` rule.
- [x] Rerun the focused test and the full Cockpit test suite.

### Task 4: Record limits and verify the finished flow

**Files:**
- Create: `docs/superpowers/specs/2026-10-09-session-panel-overview-known-limitations.md`
- Modify: `docs/superpowers/specs/2026-08-14-known-limitations-digest.md`

- [x] Record the live-view cap and project-scoped Browser limitation; add one digest line.
- [x] Run `bun run typecheck` after review fixes.
- [x] Run `bun test --max-concurrency=1`.
- [x] Run `bun run build`.
- [x] Run Cockpit tests and build sequentially.
- [x] Inspect the running Cockpit in a temporary profile; the disclosure expands and displays the Agent panel. Reduced motion is covered by the global CSS rule and token tests.
- [x] Run `bash ~/.codex/hooks/stop-gate.sh --root /Users/nmh/work/Mac/NMHx/Personal/crossweave/.worktrees/session-panel-overview` in the foreground and report its outcome.
