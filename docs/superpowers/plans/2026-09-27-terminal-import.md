# Plan — terminal appearance import

Spec: `docs/superpowers/specs/2026-09-27-terminal-import-design.md`
Branch: `feat/terminal-import`

1. [x] `settings.ts`: `terminal` field — types, lenient load, strict validation, save
   keeps it. Tests.
2. [x] `terminal-import.ts` (core, pure): Ghostty config + theme parsing, iTerm2 profile
   mapping (float RGB → hex, dark variants), font string split. Tests with fixtures in
   the real formats found on the dev machine.
3. [x] Main process: `terminal.importSources` / `terminal.import` channels; file lookup,
   `plutil`, NSFont family resolution. Pure path/argv helpers tested.
4. [x] Renderer: Settings "Terminal" section (import buttons, preview swatches, font,
   size, cursor, Option as Meta, reset); appearance context; XtermPane applies options
   live (pure `xtermOptionsFor` tested).
5. [x] Gates + CDP check against the real Ghostty and iTerm2 configs; known limitations.

## Outcome (2026-09-27)

Checked against this Mac's real configs: Ghostty (`theme = Catppuccin Mocha`, JetBrains
Mono Nerd Font Mono 12, Option as Alt) and iTerm2's default profile (PostScript
`JetBrainsMonoNFM-Regular 12`, resolved to its family by NSFont) both imported fully
with no notes. Import → preview → Save changed an open pane in place (font, colors,
cursor) without reopening it; the run used a temporary HOME, so the user's own
settings were not written.
