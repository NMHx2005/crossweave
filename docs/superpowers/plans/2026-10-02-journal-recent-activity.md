# Plan — Horizon B: Session journal + Recent activity

**Spec:** Long Roadmap Horizon B + `2026-10-01-deck-crossweave-bridge-design.md` §journal.
**Tier:** Medium — daemon journal (openTabs/fileSurfaces/sessionIds) + guard + unread activity feed, no new RPC.
**Status:** in progress.

## Tasks

1. **Journal:** `src/domain/journal.ts` — persist `openTabs` (sessionIds + worktree paths) + file surfaces, restore on boot with guard (no double-assign same session).
2. **Recent activity:** `src/domain/activity.ts` — unread set from `tui.event` kinds (blocked/needs_you/landed), 5 latest, ack on pane select, `View all` history.
3. **Cockpit/Deck surface:** journal restoration in `Stage` + activity feed badge.

## Gate

`bun run typecheck` · `bun run build` · `bun test` + manual restore after kill.
