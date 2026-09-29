# Cockpit settings page — a page of its own, like an editor's

**Date:** 2026-09-29
**Status:** Planned (requested in chat 2026-09-29)
**Scope:** `apps/cockpit/src/ui` (a `SettingsPage`, a section registry, the old
`SettingsPanel` retired), `apps/cockpit/electron/app-menu.ts` (⌘,), no daemon change.
**Branch:** `feat/settings-page`
**Consumers:** the voice-input design (`2026-09-29-cockpit-voice-input-design.md`) puts a
Voice section here; tmux-parity 2B (Keyboard) and 2C (persistence) add settings too.

## Problem

Settings is a modal dialog (`SettingsPanel.tsx`, 478 lines) that scrolls through seven
`<h3>` blocks — Appearance, Launchers, Terminal, Usage, Keyboard, "Cmd+click opens files in",
Notifications — with one Save at the bottom. It has no way to find a setting, no room for
descriptions, and every new feature makes the scroll longer. Two features already planned
(voice input, terminal persistence) each add a section. The user asked for a settings page of
its own, as in Cursor.

## Goals / non-goals

**Goals**
- A full-window page: a left navigation of sections with a search box, a right pane of
  rows (name and one-line description on the left, the control on the right), one section
  per screen.
- Find a setting by typing (`font`, `notify`, `voice`), across every section.
- Opened by ⌘, and from anywhere with a section target (`openSettings('voice')`), so a
  feature can send the person to exactly its own settings.
- Same settings, same validation, same storage — this is a new shape, not new behaviour.

**Non-goals**
- A JSON editor for settings (a later, separate item).
- New settings. Sections are moved, not extended, except for the empty shell voice will fill.
- Per-project settings redesign: `ProjectSettings.tsx` gets a place in the navigation and
  keeps its form.

## Design

**Shell.** `SettingsPage` replaces the stage while open (the rail stays, as the page is about
the app, not a project); Esc or a back control returns to exactly the tab and pane the
person left, focus restored. Not a second window: the cockpit is one window and the daemon
connection is per-window.

**Section registry** (`apps/cockpit/src/lib/settings-sections.ts`, pure): an ordered list of
`{ id, title, rows: [{ id, label, description, keywords }] }`. The navigation, the search
and the deep link all read it, so a row exists in one place. Search is a case- and
diacritic-insensitive match over label, description and keywords, returning matching rows
grouped by section. Tested without a DOM.

**Sections** (existing content, moved as-is):

| Section | From |
|---|---|
| Appearance | Appearance (theme, fonts, text size) |
| Terminal | Terminal (imported look, cursor, Option as Meta) |
| Keyboard | Keyboard (`ShortcutsPanel`) |
| Launchers | Launchers |
| Editor | "Cmd+click opens files in" |
| Notifications | Notifications |
| Usage | Usage (prices) |
| Project | `ProjectSettings` for the active project |
| Voice | new, empty until the voice feature lands |

**Saving.** Today a dirty form waits for one Save, and the daemon refuses an invalid value
with a message. On a page of independent rows that model is wrong: a change belongs to its
row. Each control commits on change through the **same `onSave` path** (the daemon stays the
only validator); a refusal shows under that row and the control returns to the last saved
value. Window-local choices (`notify`, the appearance preview) keep applying at once as
today. Rapid input (a text field, a slider) commits on blur or after a short pause, not per
keystroke. A row that differs from its default shows a small marker and a Reset.

**Row anatomy.** One `SettingRow` component (label, description, control slot, error line,
reset) so every section reads the same and tokens carry all the spacing — the stylesheet's
no-literal test applies.

**Deep links.** `openSettings(sectionId?, rowId?)` from a menu command or another component;
the page scrolls the row into view and briefly highlights it (one restrained pulse, honouring
reduced motion).

## Testing

- `apps/cockpit/tests/settings-sections.test.ts` — search finds by label, description and
  keyword; ignores case and diacritics ("phim tat" finds "Phím tắt"); empty query lists all;
  every row id is unique; every section has at least one row once populated.
- `apps/cockpit/tests/settings-commit.test.ts` — a refused value reverts the control and shows
  the daemon's message; a valid one is saved once; debounce coalesces rapid input.
- Existing token, keymap and layout tests stay green; `tokens.test.ts` covers the new CSS.
- CDP: open with ⌘, (menu accelerator via the app), search, change a font and a notify
  option, deep-link to a section, Esc returns to the same pane; a screenshot per section.

## Risks

- **Regression in a moved section** — sections move whole and keep their existing handlers;
  no behaviour is rewritten in the same commit as its move.
- **Commit-on-change writes more often than Save did** — coalesced by debounce, and the daemon
  write is the same call, so its validation and atomicity are unchanged.
- **Losing the page's place on return** — the stage's state lives above the page (App), so the
  page unmounts without touching it; verified by the CDP return-to-pane check.

## Known limitations (to write at merge)

- No settings JSON editor and no import/export.
- Search is text only (no filters such as "modified").
- The Project section still uses its own form layout until it is converted row by row.
