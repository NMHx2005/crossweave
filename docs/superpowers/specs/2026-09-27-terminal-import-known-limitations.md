# Terminal appearance import — Known Limitations

**Date:** 2026-09-27
**Spec:** `docs/superpowers/specs/2026-09-27-terminal-import-design.md`

## What is built

- Settings → Terminal: Import from Ghostty / iTerm2 (disabled when no settings are
  found), a preview in the imported colors and font, font / size / cursor / blink /
  Option-as-Meta fields, and "Use cockpit default". Nothing is written until Save.
- `terminal` in `~/.crossweave/settings.json`, validated by the daemon; panes apply it
  live (font, colors, cursor, Option key), refitting to the new cell size.

## Gaps

- **Only the primary font is taken.** Ghostty's later `font-family` lines (fallbacks)
  and iTerm2's non-ASCII font are ignored; the cockpit's monospace stack is the fallback.
- **Not mapped:** font features and thickening (`font-thicken`), line height / cell
  adjustments, padding, opacity and blur, bold-as-bright, minimum contrast, keybindings,
  iTerm2's other profiles and per-profile triggers. Named X11 colors in a Ghostty config
  (`background = black`) are skipped — only `#rrggbb`.
- **Ghostty `config-file` includes are not followed**, and a theme is looked up only in
  `~/.config/ghostty/themes` and the app bundle at `/Applications/Ghostty.app`.
- **A light/dark theme pair imports the dark one** (the cockpit is dark); iTerm2's
  "(Dark)" colors likewise when the profile keeps separate light and dark colors.
- **An imported palette is not contrast-checked** — it is the user's own terminal's.
  The pane's colors can now differ from the chrome's; the default is unchanged and
  still pinned by `tokens.test.ts`.
- **A one-time import**: later changes in Ghostty or iTerm2 need another Import.
- **Font availability is checked on this Mac at import time**; a settings file copied to
  another machine may name a font that is not installed there (xterm then falls back).
