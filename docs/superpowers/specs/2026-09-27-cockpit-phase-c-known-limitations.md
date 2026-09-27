# Cockpit phase C (app theme) — Known Limitations

**Date:** 2026-09-27
**Plan:** `docs/superpowers/plans/2026-09-27-cockpit-roadmap.md` (Phase C)

## What is built

- Settings → Appearance → Theme: **System** (follows macOS, live), **Dark** (the tokens
  as before), **Light** (One Light family), **From terminal** (the whole window derived
  from the colors imported under Terminal, each role nudged until its pairs pass AA).
  Previewed while choosing, kept on Save.
- A theme is a full color-token set; `tests/tokens.test.ts` runs every WCAG check for
  Dark, Light and four terminal palettes (Catppuccin Mocha, Solarized Light, Gruvbox
  Dark, and a deliberately low-contrast one).
- Terminal panes follow the theme when no colors were imported (One Light's ANSI on
  Light); the pane is painted in the terminal's own background (the strip under the
  last row used to show xterm's stylesheet black).
- Found by running the checks on every theme: Dark's `--cw-blocked` was 4.0:1 as a
  danger menu item's text on a hovered row; now `#ff7580` (4.56:1).

## Gaps

- **The first frame is dark**: `index.html` pre-paints `--cw-surface` of Dark before the
  saved theme loads, so a Light window flashes dark at launch.
- **Agent marks are not contrast-checked** (glyphs, not text) and on "From terminal"
  keep the Dark/Light set's hues.
- **"From terminal" follows the imported colors only**: it has no light variant of a
  dark palette; System does not switch it.
- **Chrome colors that come from a nudge can drift from the terminal's hue** on
  low-contrast palettes — legibility wins over faithfulness.
