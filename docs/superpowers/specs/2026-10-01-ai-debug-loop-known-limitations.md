# AI debug loop — known limitations (interim, 2026-10-01)

Written early per house rules: these gaps exist in the code on `main` **now**; the
final milestone limitations will replace this when Phases 2–6 land.

## Phase 5–6 — responses view and browser errors (on main)

- The Responses view is **in memory only**: closing the window forgets which sessions
  the last prompt reached (per design §3 — worth one working stretch, not a restart).
  It lists only sessions that TOOK the prompt; a refused one never appears.
- `cw browser errors` is a **convenience over two calls** (`browser.console` level=error
  + `browser.network` failed): each is bounded and permission-checked on its own, and a
  refusal of one still fails the whole command. Page text is untrusted data.
- The Debug pane's browser section reads only panes whose access is **Read or Control**
  (a pane at Off captures nothing) and only panes of THIS project; it is read-only (no
  dialog, no activity line) and bounded (25 rows per pane, 50 in total). Its
  running-app (CDP) behaviour is unverified.

## Phase 4 — Debug pane + send-to-session (on main)

- The Debug pane refetches on the session-list revision only: an error that arrives
  while no list change happens waits for the next revision (open the pane again, or
  any rail activity) — honest for a heuristic surface.
- "Send to session" drafts the text into the composer; the EXACT preview + per-session
  refusal reasons there are the real gate. The button preselects the focused session —
  the person can retick others.
- The pane mounts only when a session row says it exists; a landed/removed session's
  pane renders nothing.
- Its BROWSER half comes from main and shows only this project's panes above Off (see
  the Phase 5–6 section); with no such pane the section is empty.
- A live scratch-app inspection confirmed the session-row tooltip distinguishes
  terminal-inferred status from a `cw notify` signal and shows the relative event age.
  A composer send populated the Responses dialog. With Agent access set to Read for a
  localhost fixture only, the Debug pane showed its console error and failed request;
  access was restored to Off before closing the Browser pane.
- Automated stability checks are deterministic, but this pass has no week of owner
  usage to establish real-world reliability or capacity. Existing bounds include
  64 KiB of in-memory replay per shell/extra terminal, six mounted project views, and
  twelve WebGL contexts; overflow falls back to the DOM renderer. These caps limit
  retained state, not total CPU or memory under arbitrary workloads.

## Drag panes — the live preview (on main)

- The preview shows the session-bound panes' re-arrangement for the CURRENT hover
  target only; when the dragged pane moves to a DIFFERENT target mid-drag, the pane's
  place in the tree changes and the view re-mounts it — an Xterm re-attaches its pty
  (scrollback replays from the daemon, a flash). Holding the pointer on one target
  (the common case) mounts nothing.
- A cross-tab drag keeps the old target-highlight behaviour; no arrangement preview.
- Cancelling a drag slides the panes back to where they were (one flip animation).
- The preview runs `movePane`, which drops the tab's zoom: starting a drag in a zoomed
  tab un-zooms it visually until the drag ends.

## Phase 1 — status across split panes (on main)

- A pane's screen starts at **80×24** until the client resizes (same contract as the
  session's own pty, `runtime.ts`); a client that attaches and never resizes (some CLI
  paths) is read at the wrong width, so screen words may be missed until a resize.
- `judge`/`activityOf` mutate while reading (`screenSpoke`, `lastBusyAt`), and are now
  called from both `session.list` redraws and the 1.5 s sweep: the busy-grace window
  can stretch a little under frequent redraws. Pre-existing, multiplied by panes.
- The sweep announces changes only for sessions it has a track for: a session whose
  shell was never started (daemon restart, pane restored) that a pane then moves will
  not broadcast on its own — the next `session.list` still shows the right status.
- An app-injected write into a pane ("Send to session", Phase 4) counts as the user
  being present: it clears that session's `cw notify` word. Deliberate (2026-10-01).
- A row's `agent` prefers the session shell's own agent over a pane's agent; when
  several panes run different agents, the row names the first one found — one agent
  per row is the rail's shape.
- `ActivityTracker.forget` is not called anywhere in production today; panes kept
  alive past their session's track removal remain folded into `status()` by design.

## Phase 3 — cw debug (on main)

- The error-line detector is a **shape heuristic** (`error TS…`, `error:`, `ERROR`,
  `Traceback`, `FAIL`, ✗/✖, `Segmentation fault`) over ANSI-stripped lines — not a
  parser of any toolchain; it will miss unusual formats and can show a line that
  merely looks like one. Labelled "(heuristic)" on every surface.
- The plain `error:` shape is anchored to the START of a line, so a PREFIXED line
  (`[build] error: …`) is missed — the trade that keeps `no error: none` out. A toolchain
  that prefixes its diagnostics needs the `file:line:col: error:` or `error TS…` shapes.
- Error lines are **RAM only**: they die with the daemon (honest debug state).
- The scrubber is a heuristic too: known token shapes + secret-named key=value
  pairs. A custom-format secret in a log can still slip through — labelled so.
- Ownership by exact fixed tokens, not by provenance lookup: a user's own hook that
  happens to contain our exact argument string (`notify --kind done "finished its
  turn"`) would be treated as crossweave's. Deliberate — the string is only ever
  written by this command; a hand-copied twin is its own.
- A terminator-less giant chunk is capped to its LAST N KB and judged as one line:
  error words in its head are lost (the shape words must sit in the tail). Progress
  bars (\r-only) are unaffected — \r ends a line.
- The \r-is-a-terminator reading splits a line that used \r mid-line for drawing;
  heuristic cost, accepted.
- Error lines are keyed per session id in RAM: an id whose session was rm'd is
  forgotten (`session.rm`/`kill --rm-worktree`/`land` call forget); ids die with the
  daemon regardless.
- The scrubber covers the bundle's text fields (tail, error lines, latest words,
  branch, worktreePath, diff paths) — the session NAME and id are not scrubbed (the
  user typed the name; ids are crossweave's own).

## Phase 2 — hooks install/remove (on main)

- The engine is **remove-matches-our-fixed-args**, not provenance-lookup: removal
  works across prefix changes even if `hooks-installed.json` is lost — provenance is
  a record, not the source of truth.
- Provenance read-modify-write has **no lock**: two `cw hooks install` running at the
  same moment can lose one's record (the entries themselves are still found by the
  args match). One invocation at a time is the assumption.
- `writeTextAtomic` writes through a symlink's TARGET (a dotfiles manager keeps the
  link). A DANGLING symlink is the exception: its target cannot be resolved, so the link
  itself is replaced by a plain file.
- `cwHookPrefix` prefixes `bun` for any `.ts` entry — a checkout where the CLI is
  NOT run through bun would embed the wrong runner (today cw only runs on bun).
- A live test initially found that `$CW_SESSION_ID` reached the session shell, but
  `cw notify` then selected a daemon rooted at that linked worktree and returned
  `SESSION_NOT_FOUND`. Session and pane shells now receive `CW_WORKSPACE_ROOT`; a
  restarted demo session ran `cw notify` successfully and the owning daemon showed
  its done signal. `cw` validates the injected Git root before connecting. A session
  process must be restarted to receive the new variable.
- Gemini: no hook system **as of 2026-10** — a version with lifecycle hooks would
  make the refusal stale; re-check before adding it to the supported list.
- `installCodex` refuses instead of merging when a foreign `notify` key exists
  (single-key constraint; merging two notify programs needs a shim script — later).

## Phase 2–6 (built — remaining limits)

- Agent config writing has the pre-flight/atomic/backup/TOCTOU rules of design §1 —
  **done**. The populated Responses view and Read-gated Debug browser section were
  verified in the running scratch app on 2026-10-08.
