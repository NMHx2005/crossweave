# Settings polish and the failed-check alert — known limitations

Spec: `2026-10-11-settings-polish-check-alert-design.md` (revised after a Codex review). Plan: `docs/superpowers/plans/2026-10-11-settings-polish-check-alert.md`
(revised after a second Codex review of the plan).

## What shipped

- **Settings** read the same way in every section: no news banner (the page opens on the Dashboard, so a "New" mark would be gone before it was seen), a one-line
  lead under the title, a titled first card, the longer explanation folded under **Details**, and a column that does not shift when a scrollbar appears
  (`scrollbar-gutter: stable`). Row descriptions that ran to 340 characters are one sentence now. **Notifications** is three groups; **Checks** explains how it
  works and links to the Notifications switch; **Presets**, with none, says what a preset is. The auto-run row keeps its safety words (sandbox, every project, off
  by default) in the row itself, never only in the folded part.
- **A desktop alert when a check fails** while the window is not in front (or the project is not the visible one): `<session>: tests failed`, with `exit 1, 12.3s`
  and nothing else in it. One alert per failing run, remembered per session by the run's start time, so a late answer, a daemon restart or a verdict that
  disappears and returns cannot announce it twice; the first look at a project (and a remounted view) announces nothing; a stale verdict announces nothing.
  Switch **When tests fail** in Settings → Notifications, on by default. Click focuses the session.
- **A fix to feature 3** found by the review: `formatCheckFailure` redacted first and removed invisible characters second, so a key split by a zero-width character,
  a bidi override or an escape sequence escaped the matcher and was put back together afterwards; BEL, backspace and DEL also survived. It cleans first and
  redacts second now (regression tests were red before the change).

Cockpit only: no daemon method, RPC, CLI, schema (still v18) or dependency change.

## Verified

Unit tests: the order of cleaning and redaction, `plainLine`, `createCheckAlerts` (10 cases including the out-of-order sequence 1, 2, 1, 2), the alert's words,
the registry (every section has a summary of at most 100 characters and a folded explanation; every row description at most 160; the auto-run safety words), the
kit's `SettingsDetails`, the banner gone from the kit and the stylesheet, the column's gutter. Live, with `apps/cockpit/scripts/settings-polish-check.ts` on the
real app (a scratch HOME and project; the script refuses anything else): 17 checks — no banner or mark in any of the 11 sections, a lead, a titled first card and
Details in each section but the Dashboard, the centred column at the same x in every section, the safety words in view, Open Notifications landing on its row,
the switch on by default, exactly one alert for a real failing check with a clean title and a body of `exit N, S.Ss`, a second alert for the next failing run,
none after a reload, none with the window in front, none with the switch off.

## Limitations

- **The alert comes from the window, not the daemon.** Only projects that have a mounted view raise it (the window keeps a handful live); a failure that happens
  while a project's view is not mounted is never announced; an older daemon that does not report `check` raises none. Several sessions failing together raise
  several alerts. Native delivery and restoring a minimised window are not verified (the live script stubs the page's `Notification`).
- **It never shows the output**, on purpose (a notification can sit on a locked screen and the scrubber is a heuristic), so "what failed" always costs one click.
- **A stale verdict is not announced.** Nor does it tell an automatic run from a manual one.
- **Checks shows no live status** (command trusted or not, last run): that needs a daemon method.
- **Collapsed Details are not searched by their body**, only through each row's words and keywords.
- **`SettingsPage` itself has no unit test** (it needs the app's API); its structure is pinned by the registry tests and by the live script.
- The finished and asking alerts share an ordering hazard that was there before (the load-order guard runs before the terminals are fetched); the new alert is
  immune because it remembers run identities, the other two are unchanged.
- In screenshots taken from a background window, the navigation can show two items highlighted: the hover transition of a window that is not in front lags one
  step. It is not a state of the page.

## Ideas not built

A live status line in Checks (needs a daemon method), a sound of its own for failures, an alert from a closed window (the daemon would have to ask the OS), quiet
hours, observing every project from one place, alerts for a pass, an "also show the first line of the output" opt-in.
