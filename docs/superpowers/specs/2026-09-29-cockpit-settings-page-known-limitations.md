# Cockpit settings page — known limitations

**Date:** 2026-09-29 · Design: `2026-09-29-cockpit-settings-page-design.md` · Branch `feat/settings-page`

## What shipped

A window-sized settings page replaces the modal dialog: a navigation of seven sections
(Appearance, Terminal, Keyboard, Launchers, Editor, Notifications, Usage), a search box
over every row (case- and diacritic-insensitive: "phim tat" finds "Phím tắt"), and
save-as-you-go through the same daemon call the Save button used. `lib/settings-sections.ts`
is the one description of the sections and rows; `lib/settings-commit.ts` is the debounced,
one-at-a-time committer. `scripts/settings-check.ts` walks it over CDP.

Verified on the real app with a scratch `$HOME`: it opens from the rail's gear; all seven
sections render; a search hit opens its section and marks its row; a change reaches
`settings.json` without a button and putting it back is saved too; Esc returns to the same pane.

## Where it differs from the design

- **A refusal shows a banner, not a per-row error, and keeps the draft.** The design said the
  control reverts to its last saved value. That would snatch a half-typed launcher name back
  mid-keystroke, so the page keeps what was typed, says "Not saved — <the daemon's sentence>"
  at the top, and the next change that makes the draft valid saves it. Leaving the page while it
  is invalid discards the draft (the appearance preview returns to what is saved).
- **The page is an overlay over the whole window**, not a replacement of the stage column: the
  rail is covered while it is open. The stage's state lives above it and is untouched (checked:
  the same panes are there after Esc).
- **No Voice section yet** (an empty section would be a dead end); it is registered with the
  voice feature. **The Project section is not in the navigation**: per-project settings keep
  their own dialog.
- **No per-row "modified" marker or Reset.**

## Limitations

- Notifications remain window-local choices (localStorage), applied at once, as before.
- Search matches text only; a hit navigates to the row, it does not edit in place.
- `initialRow` (scroll to and mark a row) exists but only `keyboard` is used as a deep link
  today (the shortcuts dialog's Edit).
- Esc closes the page, also while a shortcut is being recorded under Keyboard, as the old
  dialog's Esc did; not re-checked here.
- Typing in a launcher's fields can flash the "Not saved" banner while a value is momentarily
  invalid (an empty name), then clear when it becomes valid.
