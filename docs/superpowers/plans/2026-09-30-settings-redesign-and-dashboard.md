# Plan — Settings redesign and dashboard

Spec: `docs/superpowers/specs/2026-09-30-settings-redesign-and-dashboard-design.md`
Branch: `feat/settings-dashboard`
Tier: Large (backend measuring, an RPC, an IPC channel, a redesigned page, a new section with charts, real-app checks).

## Phase 1 — Measure without freezing the daemon

1. [ ] `src/daemon/disk-usage.ts`: `DiskTracker` (async walk, time slices, bounded concurrency, per-path cache and single flight,
   deadline → `approx`, no symlinks, missing/unreadable = 0). Tests first with a fake fs and clock.
2. [ ] `stats.overview` and `daemon.stats` RPCs (`methods.ts`): process figures + one row per session; `null` while unmeasured.
   Route `workspace.info`'s disk figure through the tracker so it stops blocking. Tests over the real socket.

## Phase 2 — The model (pure)

3. [ ] `apps/cockpit/src/lib/dashboard.ts`: `formatBytes`, totals, per-project rows, the five suggestions with their guards and
   thresholds, the 14-day series. `tests/dashboard.test.ts` first, with the edge cases from the spec.
4. [ ] Main-process aggregator + `dashboard.get` channel: every open project's `stats.overview` (old daemon → `needsRestart`), plus
   `app.getAppMetrics()`. Tests with fakes.

## Phase 3 — The look

5. [ ] `SettingsKit` (`SettingsGroup`, `SettingRow` from the registry, `Switch`, `Banner`) and the Cursor-style CSS from tokens; pilot on
   Notifications, look at it, then move every section.
6. [ ] Grouped nav with icons, Back, search, dismissible banner; deep links and `data-setting` ids intact.

## Phase 4 — The dashboard

7. [ ] Section `dashboard`: tiles, suggestions with confirm dialogs, projects table, sessions list with actions, disk-by-project and
   sessions-per-day charts (SVG, dataviz rules, table view), states: loading, measuring, needs-restart, empty, error.
8. [ ] `scripts/dashboard-check.ts` on the running app; screenshots of each state; fix what the eye finds.
9. [ ] Docs: known limitations, digest, README/PROGRESS/AGENTS, release notes.

## Gate (each phase)

`bun run typecheck` · `bun test --max-concurrency=1` · `bun run build` · cockpit `bun test` + `bun run build` · the phase's script.
