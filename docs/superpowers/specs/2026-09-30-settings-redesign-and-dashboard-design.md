# Settings redesign (Cursor-style) and a resource dashboard

**Date:** 2026-09-30
**Status:** Approved in chat 2026-09-30 ("làm lại trang Settings cho giống Cursor, thêm dashboard thống kê project và session, và đề xuất xóa để nhẹ máy")
**Branch:** `feat/settings-dashboard`

## Problem

1. Leaving sessions open costs RAM (a shell each, plus what runs in it) and, above all, **disk**: every session with its own worktree holds a
   full checkout, often with `node_modules` — and *killing* a session keeps that worktree. Nothing in the app shows who holds what, so
   people find out from a "holds 36 GB" error, or not at all.
2. The Settings page has the right *structure* (nav, search, sections) but not the *look* of the reference the person likes (Cursor's):
   form-style stacked labels instead of rows of "title + description on the left, control on the right" inside quiet cards.

## Part 1 — the look (Cursor's settings, adapted to the tokens)

Studied from the reference screenshot:

- A left nav of **groups separated by hairlines**, each item an icon + label; a **Back** button and a **search** field above it.
- A centred content column (~680 px) with the section title, then **group labels** (small, muted) above **rounded cards**; a card is a list of
  **rows** separated by hairlines: label (medium) and description (muted, smaller) on the left, the control on the right — a **switch**
  (green when on), a compact select or button.
- A dismissible **banner** at the top for news; rows never shout.

What changes here:

- New `SettingsKit`: `SettingsGroup`, `SettingRow`, `Switch` (`role="switch"`), `Banner`. A `SettingRow` takes its **label and description from the
  registry** (`settings-sections.ts`) by `id`, so the row, the search index and the deep links can never drift apart.
- Every existing section is moved onto the kit; controls keep their behaviour and their `data-setting` ids (so deep links and the existing
  `settings-check.ts` keep working). Tall custom editors (launchers, presets, env) stay as blocks inside a card.
- Nav groups: *General* (Dashboard, Appearance, Notifications) · *Sessions* (Launchers, Presets, Prompt, Editor) · *Terminal* (Terminal,
  Keyboard) · *Usage*. Search unchanged. Colours, spacing and radii come from `tokens.ts` only (`tokens.test.ts` keeps enforcing it,
  including contrast on every text/background pair).
- Reduced motion: the switch and the card hover collapse to no transition like everything else.

## Part 2 — the Dashboard (a section of Settings, first in the nav)

Shows what the open projects and their sessions cost, and **suggests** what to stop or delete. It never acts by itself.

### Data (what exists, what is new)

| Figure | Source | New? |
|---|---|---|
| Sessions per project by status, age, last activity | `session.list` | no |
| **Disk per session's worktree** (+ lease dirs), per project total, the limit | `directorySize` over each worktree, **measured off the event loop, cached** | **yes** — `DiskTracker` |
| Commits ahead / uncommitted files (what deleting would lose) | `GitCounter` (already on `session.list`) | no |
| Tokens and cost | `usage` on `session.list` and the priced models in Settings → Usage | no |
| **Daemon memory** per project (RSS, uptime, terminals, sessions) | `process.memoryUsage()` in the daemon | **yes** — folded into `stats.overview` (no separate `daemon.stats` RPC was needed) |
| **App memory and CPU** (main, renderer, GPU, webviews) | Electron `app.getAppMetrics()` | **yes** — one IPC channel |
| Sessions started / landed per day | session rows + `session_history` | no |

`stats.overview {workspaceId}` returns, per project: the daemon's process figures and one row per session (id, name, status, branch,
`shared`, created / last active, `diskBytes` or `null` while unmeasured, `approx`, `ahead`, `changed`, tokens, cost). The window's main
process calls it for every open project and adds the app's own figures; an **older daemon** answers "unknown method", which the page shows as
"Restart this project's daemon to see its numbers" — never as an error.

### Measuring disk without freezing the daemon

`directorySize` is a synchronous recursive walk: on a checkout with `node_modules` it blocks the daemon for seconds, and `workspace.info`
already runs it on the RPC path. `DiskTracker` walks **asynchronously** with a bounded concurrency and a time slice (it yields to the event loop
every few milliseconds), keeps a **60 s cache** per path, allows **one walk per path at a time**, gives each path a **deadline** (past it the figure
is a lower bound flagged `approx`), never follows symlinks, and treats a vanished or unreadable directory as 0. The first `stats.overview`
returns `null` for what is not measured yet and starts the walks; the page shows "measuring…" and refreshes.

### Suggestions (pure, testable: `src/lib/dashboard.ts`)

Ranked by bytes reclaimed, each with a reason, what would be lost, and a single action:

1. **Ended sessions still holding a worktree** (landed / killed, worktree on disk) → *Clean up* (`workspace.gc`). Safe: gc keeps the ones
   with unlanded work, and the suggestion says so.
2. **Stopped sessions with nothing to lose** (no commits ahead, no uncommitted files) that nobody touched for 7 days → *Delete*.
3. **Stopped sessions with unlanded work, idle for 14 days** → *Land or delete*, marked **has unlanded work**, never one-click.
4. **A running shell idle for 24 h with no agent** → *Stop* (frees RAM, keeps the worktree).
5. **A project with no running session whose daemon still holds memory** → *Close the project*.

A suggestion is a proposal: every action goes through the existing confirm dialog naming exactly what will be lost (commits, uncommitted
files, size). Thresholds are named constants, not settings. A session in the project folder itself ("shared") is never sized or suggested for
deletion: it *is* the user's checkout.

### The page

Stat tiles (projects, sessions running / stopped / ended, worktree disk, memory now) → **Suggestions** → a sortable **Projects** table → a
**Sessions** list (top consumers first, with Stop / Delete buttons) → two small charts: **disk by project** (horizontal bars, one hue, direct
labels) and **sessions started per day**, 14 days. Charts follow the data-visualisation rules: one axis, thin marks, rounded data ends, values in
text tokens (never the series colour), a table view of the same numbers, and no colour-only encoding. A "Refresh" button and an "as of hh:mm:ss"
stamp; stale answers are dropped by a load gate.

### Edge cases the design has to survive

No project open; a project closed while its numbers load; a daemon that is old, unreachable, or slow; a worktree that vanished, is unreadable or
holds a symlink loop; a walk past its deadline; bytes that are `null`, zero, negative, `NaN` or absurdly large; a session deleted between
listing and acting (the action reports "already gone", not a crash); two deletes clicked in a row; a name of any length (ellipsis); a narrow
window (tiles wrap, the table scrolls); reduced motion; a dark or light theme; keyboard-only use (every button reachable, `Escape` closes dialogs).

## Non-goals

Automatic cleanup; a scheduler; per-process CPU history; charts of tokens over time; remote monitoring; changing what `gc` removes.

## Testing

Pure logic in `bun test` (formatting, suggestion ranking and its guards, the disk tracker with a fake filesystem and clock, the stats method over the
real socket); cockpit tests for the model; then the running app measured with `apps/cockpit/scripts/dashboard-check.ts` and a screenshot
of each state — the way earlier phases were checked.
