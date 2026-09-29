# Plan — cockpit settings page

Spec: `docs/superpowers/specs/2026-09-29-cockpit-settings-page-design.md`
Branch: `feat/settings-page`
Tier: Medium/Large — a new page, a registry, every existing section moved. Runs **first** of
the new work, because voice input, terminal persistence and the keyboard table all add rows.

## Tasks

1. [ ] **Registry.** `apps/cockpit/src/lib/settings-sections.ts` with the section/row model
   and diacritic-insensitive search; tests first (`settings-sections.test.ts`).
2. [ ] **Row and shell.** `SettingRow`, `SettingsPage` (nav + search + content), tokens for
   the new spacing, ⌘, in `app-menu.ts`, `openSettings(section?, row?)`, Esc returns to the
   prior tab/pane. The old panel keeps working until step 5.
3. [ ] **Commit-on-change.** The shared commit helper (same `onSave`, per-row error and
   revert, debounce); `settings-commit.test.ts`.
4. [ ] **Move the sections**, one commit each, no behaviour change: Appearance, Terminal,
   Keyboard, Launchers, Editor, Notifications, Usage, Project. Each keeps its handlers and
   tests green.
5. [ ] **Retire the modal.** Remove `SettingsPanel` and its wiring in `App.tsx`; the empty
   Voice section is registered.
6. [ ] **Gates + CDP.** Root `bun run typecheck`, `bun test --max-concurrency=1`,
   `bun run build` if `src/` changed (it should not); cockpit `bun test`, `bun run build`;
   the CDP walk in the spec with a screenshot per section.
7. [ ] **Docs.** Known-limitations file + digest line.

## Gate

`bun run typecheck` · `bun test --max-concurrency=1` · cockpit `bun test` +
`bun run build` · CDP walk + screenshots.

## Report

Screenshots of the page and the search, and the return-to-pane check, before the next phase.
