# Plan — wire the Horizon B journal and activity feed

**Date:** 2026-09-21
**Closes:** the "Nợ kỹ thuật" B list in `docs/PROGRESS.md`, and the two gaps recorded in
`docs/superpowers/specs/2026-09-21-journal-activity-known-limitations.md`.
**Tier:** Medium — daemon RPC + gateway allowlist + cockpit UI, in two steps.
**Status:** done (2026-09-21) — both steps wired, unit-tested, and checked in the running app.

## Design decisions

1. **The daemon owns the journal, clients ask over RPC.** `src/domain/journal.ts` exists
   but nothing called it. The journal is state under `.crossweave/`, and the daemon is the
   single writer of that directory — a renderer writing the file itself would bypass the
   one-writer rule AND could not work at all for a remote client arriving over the
   gateway. So: `journal.get` / `journal.set`, `journal.get` read-only.
2. **The journal is per project root and carries its `workspaceId`.** One workspace per
   root (`workspaces.init` is idempotent by canonical root), but a stale entry from a
   deleted workspace must not restore panes into a new one — a mismatched id reads as
   empty instead.
3. **Tab ids are validated against live, non-integration sessions.** The integration
   session is infrastructure the user cannot address; a journal listing it must not open
   a pane for it. Unknown ids drop, duplicates collapse (`guardRestore`, now a real
   call site rather than a tested-but-unused function), and the list is capped.
4. **`fileSurfaces` stays empty.** There is no file-surface feature to journal yet; the
   field is carried, not populated, and says so.
5. **Activity is client-side.** Unread/ack is a per-window UI state, not daemon state, so
   `ActivityFeed` stays in `src/domain/activity.ts` and the renderer drives it — the same
   module the TUI and Deck can reuse, one copy instead of one per client.
6. **Kinds are what actually has a producer.** `blocked` and `land ok` / `land failed`
   come from real `tui.event` payloads. `needs_you` keeps no producer until `waiting` is
   written by something (see `src/db/repositories/session.ts`), and is documented as such
   rather than demonstrated.

## Step 1 — journal end to end

- [x] `src/domain/journal.ts`: `workspaceId` + `at: string | null`, atomic write
      (tmp + rename), `emptyJournal`, `normalizeTabs` (dedupe → drop unknown → cap).
- [x] `src/daemon/methods.ts`: `journal.get`, `journal.set`.
- [x] `src/gateway/gateway.ts` `ALLOWED_METHODS`, `src/gateway/auth.ts` `READ_METHODS`
      / `CONTROL_METHODS`.
- [x] `apps/cockpit/electron/channels.ts`, `apps/cockpit/src/host/cockpit-api.ts`:
      two channels.
- [x] `apps/cockpit/src/lib/cockpit-host.ts`: `loadWorkspace` returns journal tabs;
      `orderSessionsByJournal` (journal order first, no duplicate panes).
- [x] `apps/cockpit/src/ui/App.tsx`, `Stage.tsx`: restore order + focus from the journal,
      report the pane set back on every change.
- [x] Tests: `tests/domain/journal-activity.test.ts` (extended),
      `tests/daemon/methods-journal.test.ts` (new), `apps/cockpit/tests/cockpit-host.test.ts`.

## Step 2 — recent activity

- [x] `src/domain/activity.ts`: `activityFromEvent` (the single parser for the payloads
      the cockpit already reads), `land_failed` kind, session key documented as the name
      the daemon's payloads carry.
- [x] `apps/cockpit/src/ui/App.tsx`: feed on `tui.event`, ack on focus.
- [x] `apps/cockpit/src/ui/AgentRail.tsx` + `app.css`: unread count, 5 latest, View all,
      click to focus — reusing the existing badge treatments so the AA coverage that
      guards them keeps applying.
- [x] Tests: mapping + unread/ack/cap in `tests/domain/journal-activity.test.ts`.

## Gate

`bun run typecheck` · `bun test` · `bun run build` · `cd apps/cockpit && bun test && bun run build`,
then the running app (journal round-trip across a restart, unread badge appears on a
blocked event). Anything that cannot run in this environment is named in the report.
