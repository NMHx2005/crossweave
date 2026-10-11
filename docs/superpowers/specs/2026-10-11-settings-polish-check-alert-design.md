# Settings polish and a desktop alert when a check fails — design

Two changes shipped together because the second needs a row on the first's page. Cockpit only: no daemon method, RPC, CLI, schema (stays 18)
or dependency changes.

## Why

- **Settings** (owner, 2026-10-11): "looks a bit sparse and messy". A walk through all 11 sections of the running app found four concrete causes:
  1. The "New: Dashboard" banner sits on top of every section but one and pushes the content down.
  2. Explanations are inconsistent: some sections end in a long paragraph under the card (Checks, Prompt, Presets, Launchers), others say
     nothing; a few row descriptions run to 170–340 characters.
  3. The content column moves by about 5 px between sections with and without a scrollbar, and some sections have a group title
     (Appearance: "Fonts", "Window") while others (Checks, Presets) do not.
  4. Short sections (Checks, Notifications, Presets) are one or two lines in a large empty page.
- **The alert**: auto-check exists so the person does not have to watch a session, yet a failing run only changes a chip on the rail. The
  cockpit already raises a desktop notification when a session finishes or asks while the window is not in front; a failed check belongs there.

## Part A — Settings

1. **No banner.** The Dashboard's news becomes a small `New` pill on the Dashboard item of the navigation. Opening the Dashboard marks it
   seen, using the key the banner used (`cw.settings.banner.dashboard.v1`), so anyone who dismissed the banner does not see the pill. The
   `Banner` component, its CSS and its state are removed: nothing else uses them.
2. **One shape for every section.** The registry gives each section a one-line `summary` that the page shows under its title. A long
   explanation moves into a native `<details>` ("Details") under the card; nothing is hidden that was shown before, it is folded. Row
   descriptions are shortened to one sentence (at most 140 characters); the words that were cut live in the section's Details.
   Every section's first card has a group title.
3. **A steady column.** `scrollbar-gutter: stable` on the content pane, so the column does not move.
4. **Fuller short sections.**
   - **Notifications** becomes three groups: *When a session needs you* (agent finishes, tests fail), *How it tells you* (sound, Dock count),
     *Updates* (new versions).
   - **Checks** gets a *How it works* group of three lines (what runs, when, where the verdict shows) above the switch, and a row that jumps
     to the new Notifications switch. No live per-project status: Settings has no project in hand, and a new RPC is out of scope.
   - **Presets**, with none yet, shows what a preset is for and one worked example in words, above the Add button.

## Part B — Alert when a check fails

- A new window preference `checkFail` (stored like the others, default **on**) with a row **When tests fail** in Notifications.
- A pure function `newlyFailedChecks(previous, next)` returns the sessions whose check *just* failed: `check.state === 'fail'` now, and
  before either the session was unknown to the window (the first load never alerts), its check was not `fail`, or its `at` differs (a new
  run that failed again). A run still `running` or a verdict that stayed the same alerts nothing.
- `ProjectView` calls it where it already decides about "finished" and "asking", with the same `away` rule (the window not in front, or the
  project not the visible one) and the new preference. One notification per session, `tag: cw-check-<id>`, title `<name>: tests failed`.
- The body is one line of the failing output's end, passed through the same cleaning as "Send test failure to shell" (secrets redacted,
  escape sequences, control and invisible characters removed) and cut at 140 characters: a notification can show on a locked screen.
- Click: bring the window forward and focus the session, as the other two do.
- It does not alert for a pass, does not press anything, writes nothing to a shell, and does not tell an automatic run from a manual one.

## Tests

- Registry: every section has a non-empty `summary` of at most 100 characters, every row description is at most 140 characters, the ids stay
  unique, search still finds each row by its label and keywords.
- `newlyFailedChecks`: first sight, pass to fail, fail unchanged, fail with a new `at`, running, fail to pass, session that left the list.
- The headline of a failure: secret shapes, escape sequences, a bidi override, an empty tail, a very long line.
- Component walks: no banner on any section; the pill shows until Dashboard is opened and not after; each section renders its summary and
  its first group title; Notifications has the new switch and it calls `onNotify`.
- The tokens test still passes with the new CSS (no literal colours or pixels, AA on the pill).
- Live, on the real app over CDP (`apps/cockpit/scripts/settings-polish-check.ts`): no banner anywhere, the pill, the column does not move
  between sections, the switch persists across a reload, and a stubbed `Notification` receives exactly one call, with a clean body, when a
  check fails while the window is away, and none while it is in front.

## Limitations to record

- The alert exists only while a cockpit window is open on the project (it comes from the window, not the daemon); an older daemon that does
  not report `check` raises none; one alert per session per failing run, and several sessions failing at once raise several.
- A stale verdict (the tree moved after the run) is still a failure the first time it is seen after the first load.
- Checks shows no live status; a per-project line ("command trusted / not trusted, last run") needs a daemon method and is left out.
- Collapsed Details are not searched by their body, only through the row words.

## Not in scope

A sound of its own for failures, a separate alert for passes, alerts from a closed window (the daemon would have to ask the OS), quiet hours.
