# Horizon B — session journal + recent activity: what is built, and what is not

**Date:** 2026-09-21
**Milestone:** Horizon B of `2026-09-21-long-roadmap-spacevibe-crossweave.md`
**Plan:** `2026-10-02-journal-recent-activity.md`, wiring plan
`2026-09-21-journal-activity-wiring.md`
**Status:** wired — the daemon owns the journal and serves it over RPC, the Cockpit
restores its pane order from it, and `tui.event` drives an unread activity list in the
rail. Verified in the running app, not only in unit tests (see "What was checked").

## What is built

- **The daemon owns the journal.** `journal.get` / `journal.set` in
  `src/daemon/methods.ts`, backed by `src/domain/journal.ts` (atomic tmp+rename write,
  dedupe/cap/validate via `normalizeTabs`). A client asks; nothing else writes the file.
  `journal.get` is in the gateway's READ_METHODS, `journal.set` in CONTROL_METHODS, so a
  read token cannot rewrite the pane set another window will restore from.
- **The Cockpit restores from it.** `loadWorkspace` fetches the journal,
  `orderSessionsByJournal` puts the journal's tabs first (dropping ids the daemon no
  longer has, and never opening two panes on one session), and the first tab becomes the
  focused pane. After any pane-set or focus change the window reports the set back.
- **Recent activity.** `src/domain/activity.ts` `activityFromEvent` parses `tui.event`
  payloads; the rail shows the unread count, the five latest, "View all" history, and
  acknowledges a session when it is selected — from the rail, a pane, or an activity row.

## What is still missing, deliberately

- **`fileSurfaces` is written empty and always.** There is no file-surface feature to
  journal; the field is carried so the shape does not have to change when one exists.
- **`needs_you` has no producer.** Nothing writes `waiting`
  (`src/db/repositories/session.ts`), so the kind exists in the feed and nothing in the
  UI presents an event as producing it.
- **No scrollback snapshot.** Plan task 3 is untouched: `XtermPane` keeps scrollback in
  its own terminal, so a window reload or a daemon restart still loses it.
- **Only the Cockpit takes part.** The CLI TUI neither writes the journal nor restores
  from it, so a TUI-only workflow comes back to nothing. Wiring it is the same two RPCs
  whenever it is wanted.
- **Unread is per-window and in-memory.** That is the design, not a gap: unread means
  "since this window started looking", not a durable inbox.
- **A window with no sessions writes nothing.** The journal keeps its previous entry;
  stale ids are filtered on the way back in, so this is safe rather than tidy.

## What was checked

Live, against the running app (`/tmp` spike, fixture repo, two sessions): the Recent
section renders and starts empty; the window reports its pane set (journal.json appears
with the focused session first); a `land.session` event becomes an activity row with the
unread badge and "View all"; and after a restart with a hand-written journal the focused
pane is the journal's first tab. Plus `bun run typecheck`, `bun test` (journal/daemon/
gateway/cockpit units) and `bun run build` in both the repo and `apps/cockpit`.

Not checked anywhere: a `blocked` event's row (the live run produced a `land` event;
both come through the same parser and the same feed), and the cockpit's packaged build.
