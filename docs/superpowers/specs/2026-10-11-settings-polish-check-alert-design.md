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

1. **No banner.** The Dashboard's news becomes a small `New` pill on the Dashboard item of the navigation. The pill is plain text inside the item (no second control), and the Dashboard
   counts as seen whenever it is the open section, however it was reached (the default, a deep link, a search hit). It is marked seen, using the key the banner used (`cw.settings.banner.dashboard.v1`), so anyone who dismissed the banner does not see the pill. The
   `Banner` component, its CSS and its state are removed: nothing else uses them.
2. **One shape for every section.** The registry gives each section a one-line `summary` that the page shows under its title. A long
   explanation moves into a native `<details>` ("Details") under the card; nothing is hidden that was shown before, it is folded. Row
   descriptions are shortened to one sentence (at most 160 characters); the words that were cut live in the section's Details.
   Safety facts are never folded: the auto-run row keeps, in view beside its switch, that it runs code the agent just wrote, outside the
   agent's sandbox, for every project, and is off by default. Details is a sibling of the note (a `<details>` with its `<summary>` first,
   not inside the `<p>`), keyboard-operable, and a section's search words stay in its registry rows. Every section but the Dashboard
   (which has its own layout) has a titled first card.
3. **A steady column.** `scrollbar-gutter: stable` on the content pane, so the column does not move.
4. **Fuller short sections.**
   - **Notifications** becomes three groups: *When a session needs you* (agent finishes, tests fail), *How it tells you* (sound, Dock count),
     *Updates* (new versions).
   - **Checks** gets a *How it works* group of three lines (what runs, when, where the verdict shows) above the switch, and a row that jumps
     to the new Notifications switch. No live per-project status: Settings has no project in hand, and a new RPC is out of scope.
   - **Presets**, with none yet, shows what a preset is for and one worked example in words, above the Add button.

## Part B — Alert when a check fails

- A new window preference `checkFail` (stored like the others, default **on**) with a row **When tests fail** in Notifications.
- A pure function `newlyFailedChecks(sessions, notified)` returns the sessions whose check is a finished failure that has not been
  announced: `check.state === 'fail'`, `check.stale === false`, and `check.at !== notified.get(session.id)`. `notified` is a per-window
  map from session id to the `at` of the last failing run it was told about. A run still `running`, a pass, a stale verdict and a verdict
  already announced alert nothing, however many times the list is reloaded, reordered by a late answer, or the verdict disappears and
  comes back (a daemon restart keeps the same `at`).
- The first snapshot of a project seeds `notified` with every failure already there and alerts nothing; a `ProjectView` that is remounted
  starts from that same silence. Later snapshots alert for what is new and record it.
- `ProjectView` calls it where it already decides about "finished" and "asking", with the same `away` rule and the new preference, and
  records what it announced even when away is false (a failure seen on screen is not announced later). One notification per session,
  `tag: cw-check-<id>`, title `<name>: tests failed`.
- **The body never carries the test output.** It says `exit <code>, <seconds>s` (or `The project's tests failed` when neither is known) and
  nothing else: a notification can sit on a locked screen or in a notification centre that syncs to other devices, and a scrubber is
  heuristic. The session name is cleaned of control and invisible characters like any repository text. The output stays one click
  away, behind "Send test failure to shell".
- Click: bring the window forward and focus the session, as the other two do.
- It does not alert for a pass, does not press anything, writes nothing to a shell, and does not tell an automatic run from a manual one.

## Part C — The failure text is cleaned before it is redacted (a fix to feature 3)

A review of this design found that `formatCheckFailure` redacts first and strips invisible characters second, so a secret split by a
zero-width character (`pass\u200bword=hunter2`) is not matched and becomes readable afterwards; it also leaves BEL, backspace and DEL in
the pasted text. The order becomes: strip escapes, invisible and control characters (keeping newline and tab), collapse `\r` rewrites,
then redact, then cut. A regression test fails before the change and passes after it.

## Tests

- Registry: every section has a non-empty `summary` of at most 100 characters, every row description is at most 160 characters, the ids stay
  unique, search still finds each row by its label and keywords, and the auto-run row's words still say "outside the agent's sandbox",
  "every project" and "off by default".
- `newlyFailedChecks`: pass to fail, fail unchanged, the same failure listed again after a late answer, fail with a new `at`, running, stale,
  fail to pass, a verdict that disappears and returns with the same `at`, a session that left the list, a session first seen later with a
  failure; and the seeding of a first snapshot.
- The failure text (Part C): a secret split by a zero-width character, by a bidi override and by an escape sequence, BEL/backspace/DEL, a very
  long line, an empty tail, a secret shape alone (regression: red before the reorder).
- The alert's words: `exit 1, 12.3s`, only a code, only a time, neither; a session name with a newline or a bidi override.
- Component walks: no banner on any section; the pill shows until Dashboard is opened by any route and not after; each section renders its
  summary and a titled first group (Dashboard excepted); Details is a sibling of the note with its summary first; Notifications has the new
  switch and it calls `onNotify`.
- The tokens test gains the pill on the navigation's normal, hover and active backgrounds in every theme (AA), and still has no literal
  colours or pixels.
- Live, on the real app over CDP (`apps/cockpit/scripts/settings-polish-check.ts`): no banner anywhere, the pill, the column does not move
  between sections, the switch persists across a reload, and a stubbed `Notification` receives exactly one call, with no test output in it,
  when a check fails while the window is away, none while it is in front, and none again after a reload.

## Limitations to record

- The alert comes from the window, not the daemon: only projects that have a mounted view raise it (the window keeps a handful live), a
  failure that happens while a project's view is not mounted is never announced, and an older daemon that does not report `check` raises
  none. Several sessions failing together raise several alerts. Native delivery and restoring a minimised window are not verified by the
  tests (the page's `Notification` is stubbed); that is left to the owner's own use.
- A stale verdict is not announced at all (the person has moved on); a failure that is already stale when first seen is silent.
- The alert never shows the output, so "what failed" always costs one click.
- Checks shows no live status; a per-project line ("command trusted / not trusted, last run") needs a daemon method and is left out.
- Collapsed Details are not searched by their body, only through the row words.
- The existing "finished" and "asking" alerts share a pre-existing ordering hazard (the load-order guard runs before the terminals are
  fetched); the new alert is immune because it remembers run identities, the other two are left as they are.

## Not in scope

A sound of its own for failures, a separate alert for passes, alerts from a closed window (the daemon would have to ask the OS), quiet hours.
