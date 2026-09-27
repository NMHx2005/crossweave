# Terminal appearance — import from Ghostty and iTerm2

**Date:** 2026-09-27
**Status:** Implemented (2026-09-27)
**Scope:** `src/core/settings.ts` (schema), `src/core/terminal-import.ts` (parsers),
cockpit main process (reading the files), Settings, terminal panes.

## Problem

The cockpit's terminal panes use crossweave's own palette and font. The user lives in
Ghostty and iTerm2 and wants the panes to look like them, the way Cursor imports a
VS Code setup: one click, then adjustable.

## What is imported

| Setting | Ghostty | iTerm2 (default profile) |
|---|---|---|
| Font family | `font-family` (first one) | `Normal Font` (PostScript name → family via NSFont) |
| Font size | `font-size` | `Normal Font` size |
| Colors | `theme` file + `palette`, `background`, `foreground`, `cursor-color`, `cursor-text`, `selection-background` overrides | `Background/Foreground/Cursor/Cursor Text/Selection Color`, `Ansi 0–15 Color` (the `(Dark)` variants when the profile keeps separate light/dark colors) |
| Cursor | `cursor-style`, `cursor-style-blink` | `Cursor Type`, `Blinking Cursor` |
| Option as Meta | `macos-option-as-alt` | `Option Key Sends` = Esc+ |

Ghostty's `theme = light:X,dark:Y` takes the dark one (the cockpit is dark). Theme
files are looked up in `~/.config/ghostty/themes` then the app bundle's
`Contents/Resources/ghostty/themes`. Everything else in either app is not mapped.

## Where it lives

- **`~/.crossweave/settings.json` → `terminal`**, per user like the rest of Settings,
  validated by the daemon: font family limited to letters, digits, spaces and `._+-`;
  size 8–32; colors `#rrggbb`; 16 ANSI colors or none. A bad saved value is dropped on
  load, not fatal.
- **Import is read-only and local**: the main process reads the files (Ghostty's
  config, `plutil -extract` on iTerm2's plist, `osascript -l JavaScript` + NSFont for
  the family) and hands the result to Settings as a draft. Nothing is written until
  the user saves. The font name reaches `osascript` as an argument, never inside the
  script.
- **Panes apply it live**: the window loads `terminal` once and on every save; each
  xterm updates its font, theme, cursor and Option key in place.

## Design-system note

The chrome keeps its tokens. The pane's colors may now differ from the chrome's
(the user's choice); with nothing imported the pane uses `XTERM_THEME` as before, and
`tokens.test.ts` still pins that default. Imported colors are not contrast-tested —
they are the user's own terminal's.
