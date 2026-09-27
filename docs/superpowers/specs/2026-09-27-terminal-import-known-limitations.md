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

## Follow-up (2026-09-27): the window's fonts, split characters, the Changes toggle

- **Settings → Appearance**: interface font, code font (commands, paths, branches, the
  file editor) and text size (small / default / large, a pixel on every step of the
  type scale), chosen from the fonts installed on this Mac (read through NSFont, each
  drawn in its own face, searchable, good ones first). Shown live while choosing;
  Cancel puts the saved look back. The terminal font uses the same picker.
- **Split characters no longer turn into `�`.** The pty's output was decoded chunk by
  chunk; a character cut between chunks (Claude Code's `─` rules, Vietnamese letters)
  became U+FFFD and every such line wrapped a cell off. Decoded as one stream now.
- **The Changes button toggles**, shows when it is on, and a session in the project
  folder gets an explanation (no branch, nothing to land) instead of the daemon's error.

### Gaps

- **Font names with characters outside `A-Za-z0-9 ._+-`** (an apostrophe, accents) are
  not offered — the family is written into CSS and xterm's font string.
- **The font list is read once per app run**; a font installed meanwhile shows after a
  restart. SF Pro (the system face) is offered as "System", not by name.
- **Text size moves the type scale only**; row heights and spacing stay, so "large" is
  one pixel, not a zoom.
- **A daemon started before the split-character fix keeps decoding the old way** until
  it restarts.
