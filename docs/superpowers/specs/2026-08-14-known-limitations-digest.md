# crossweave — known limitations, before you rely on this

Every milestone ships its own `*-known-limitations.md` next
to this file, written at merge time with the specific gaps found and
deliberately deferred during that milestone's review. This digest doesn't
replace them — it pulls out the subset that actually matters before you
point crossweave at a real project, so you don't have to read eight
documents to find them. Full list, per milestone, at the bottom.

## The ones that change what you should trust it with (current, 2026-10-11)

**Nothing confines or guards the agent.** Since 2026-09-27 a session is a git worktree plus *your* shell in it. There is no
Safe Mode, no tier, no Collision Radar and no OS sandbox: whatever you type in that shell (`claude`, `codex`, a script) runs with
your own rights and can write anywhere you can. The only collision signal left is a file-level **overlap** warning, a signal and never
a guard (`2026-09-28-overlap-signal-known-limitations.md`). The paragraphs that described the removed layers are kept below under
"Historical", because the milestone documents still refer to them.

**`converge.testCommand` and hooks are arbitrary shell, run automatically once trusted.** `cw config trust` (and `cw config trust
hooks`) must record the current command before crossweave runs it, for `cw land`, `cw check` and `hooks.sessionSetup`. Treat that gate as
a real trust boundary: do not trust a `crossweave.config.json` you did not write. Since 2026-10-10 the opt-in `checks.autoRun`
also makes **an agent's finished turn start a run of that trusted command**, outside the agent's control, for every project whose command
you trusted (`2026-10-10-auto-check-known-limitations.md`). It is off by default.

**Commands you wrote run for you, with no trust step.** Presets, launchers and the composer's Refine command live in
`~/.crossweave/settings.json`; the cockpit's main process mends those blocks if an older daemon drops them.

**What a session is doing is inferred, not reported.** Working / done / asking come from screen words, output, the bell and the
process tree; they are reliable for Claude Code, Codex and Gemini and approximate for anything else. `cw notify` and
`cw hooks install` make the agent say it itself. A "turn ended" for checkpoints and auto-check is the same inference.

**The command bridge and `cw notify` accept an unauthenticated same-user caller by design.** Safety is per kind, in the cockpit: closed
namespaces, and the person is asked before anything beyond arranging panes or showing a mark. A same-user process can register on the
bridge first (`2026-09-29-cockpit-command-bridge-known-limitations.md`). Nothing in the daemon listens beyond its unix socket.

**Landing is evidence-gated, and the question before it is advice.** Landability comes from recorded trial merges. The cockpit's Land
button also asks when the last tests failed and when the session touches secret-like or automation files (judged by file *name*
only); `Land all ready`, `cw land` and other clients do not ask (`2026-10-10-sensitive-files-known-limitations.md`). On the local
completion branch, live Cockpit Land now requires readable, clean uncommitted status and a separate stop confirmation; the daemon
rechecks status before and after stopping running or legacy `waiting` sessions and keeps the worktree if a late write appears
(`2026-10-11-cockpit-live-session-land-known-limitations.md`).

**Runtime leases are cooperative, not enforced isolation.** crossweave injects per-session port, Docker, cache and database
environment values, but a process that ignores them can still use shared resources and collide with another session.

**Checkpoints are git objects in your repository.** `refs/crossweave/checkpoints/...` are hidden from branches but visible to
`git log --all`; restore moves no branch and refuses before touching anything it would destroy; ignored files are out of scope
(`2026-10-10-session-checkpoints-known-limitations.md`).

**The cockpit is not Apple-notarized**, and macOS arm64 only.

## Historical: the layers removed on 2026-09-27 (tag `v0.3-radar`)

Kept so the old milestone documents still read correctly. **None of this exists in the current code.**

- **Safe Mode** (M5a) had no auth boundary: any agent could turn off its own enforcement. T1 (ACP, Cursor) failed closed on an
  internal error, T2 (the Claude Code hook) failed open on purpose, and only `Edit`/`Write` tool calls were blocked, never a write
  made through `Bash`. The Cursor ACP path was gone from `cursor-agent` 2026.08, and the print-mode path had no interception.
- **The OS sandbox** (macOS seatbelt, Linux bubblewrap) confined a session's writes to its worktree and denied network by default.
- **Collision Radar** attributed only committed lines to `cw blame`; mid-flight collisions relied on the live hook/watcher path.

## Everyday gaps worth knowing, not blocking

- **Website sitemap (observed live 2026-10-11; fixed 2026-10-12):** Pages run `38234215498` published the HTTPS fix, and live `robots.txt`, all 12 sitemap URLs, homepage canonical, and hreflang alternates have been checked. Chromium's seven-route keyboard and playback checks pass; Safari normal-motion autoplay and Pause/Play pass a manual smoke check; Firefox and Safari reduced-motion/no-JavaScript playback remain untested. Independent Vietnamese human proofreading remains pending (`2026-10-11-website-v2-known-limitations.md`).
- **Website developer pages (2026-10-13):** Download, Docs and Changelog now have EN/VI release and section navigation; docs search/version snapshots and changelog filtering/pagination are absent. Chrome visual review covered desktop and 390px mobile layouts; Firefox/Safari and independent Vietnamese technical proofreading remain pending (`2026-10-13-professional-subpages-known-limitations.md`).
- **Homepage workflow illustration (2026-10-13):** the diagram now has moving route dashes and localized hover, keyboard and touch explanations; reduced-motion and unsupported view-timeline paths retain a complete static illustration (`2026-10-12-homepage-product-storytelling-known-limitations.md`).
- **Website SVG stylesheet cache (2026-10-13):** generated HTML fingerprints the exact emitted CSS in its URL, so a fresh SVG page cannot silently reuse hours-old styles and render its nodes black; already-open tabs still need a refresh (`2026-10-13-website-svg-cache-known-limitations.md`).
- Desktop notifications are **macOS only**; other platforms get a silent
  no-op, not a degraded warning. (M6b)
- Notification click-through needs `terminal-notifier` (an optional
  Homebrew dependency) and always opens Terminal.app, never your actual
  terminal. (M6b)
- Budget/burn numbers are **not authoritative billing data** — they're a
  local estimate, useful for an at-a-glance sense of spend, not for
  invoicing. (M6a)
- **`cw land` waits on the background scheduler.** Landability is decided from
  recorded trial evidence, and evidence is only valid against the base commit it
  was trialled against — so right after a land (or any commit on the base branch)
  every remaining session sits at `unknown` until the convergence scheduler
  re-trials it, up to `converge.trialDebounceMs` later. `cw converge status`
  names that as the reason; `cw land all` stops with "nothing to land" rather
  than landing on stale evidence. Re-run it once the scheduler has caught up, or
  use `--force` to land on incomplete evidence deliberately.
- A killed session's name can't be reclaimed immediately. (M0)
- **Cockpit** (`apps/cockpit/`) is the macOS arm64 desktop client — multi-pane
  xterm, attention rail, evidence-gated land from UI. **Windows cockpit is
  deferred** until `cwd` runs on Windows (`macOS-only-v1`); no Linux cockpit
  package in v1. The CLI TUI (`cw tui`) remains the cross-platform dashboard. Cockpit is not yet Apple-notarized; checksum verification
  protects the downloaded release asset, while `cw tui` remains the recovery path
  if LaunchServices accepts an app that later crashes. See
  `2026-09-18-cockpit-daily-driver-known-limitations.md`.

## Where the roadmap horizons stand (2026-09-21)

> Historical (2026-09-21 to 24). The gateway, E2E sealing, telemetry ping and the Deck bridge described here were removed or
> superseded on 2026-09-27 (`v0.4-remote-web`); read it as a record, not as the current state.

**Horizon D is wired** (ab8ed61→92bbafd): CI `sandbox-linux` job (ubuntu-latest + bubblewrap) proves `buildBwrapArgs` escape table; `session.data` E2E helpers `src/gateway/e2e.ts` (HKDF + aes-256-gcm via node:crypto, no native) — relay `src/gateway/relay.ts` stays dumb forwarder, ends enforce allowlists. Relay deploy + workspace routing remain deferred. Horizon E adds `workspace.openFile` READ (path containment, 512k cap) + web client `openFile`; Horizon F adds `bwrap` check to `install.sh`. Sprint `eff82d9` adds telemetry opt-in (`src/gateway/telemetry.ts`, per-day file, consent 0600, no code/paths/prompts) and E2E wire (`src/client/rpc-client.ts` decrypts `E2EBlob` chunk when gateway token exists, fallback plaintext).

**Horizon C is wired (engine + cockpit + telemetry):** `usage.summary` READ RPC aggregates `SessionRow` by `day`/`agent`/`day+agent`; cockpit shows table with "estimate, not billing". Telemetry `src/gateway/telemetry.ts` is wired (opt-in per-day file 0600 + best-effort POST `api.deck.spacevibe.dev/v1/ping`), default OFF — consent stored 0600, never sends code/paths/prompts. Token semantics still M6a: ACP `tokenSpent` is context occupancy, may decrease after compaction. (`2026-09-24-horizon-c-usage-design.md`, `2026-09-24-c-telemetry-optin-design.md`)

**Horizon B is wired**: the daemon owns `journal.get`/`journal.set`, the Cockpit
restores its pane order and focus from it, and `tui.event` drives an unread activity
list in the rail — checked in the running app, not only in unit tests. What it still
does not do (no scrollback snapshot, no `needs_you` producer, `fileSurfaces` empty, TUI
not participating) is in `2026-09-21-journal-activity-known-limitations.md`.

**Horizon A is wired crossweave-side** (`d99893d`): `src/domain/attention.ts` shared, `DeckBridge` has a call site (`src/deck/index.ts`), `WorktreeCard` carries `heading/colour/dot/selected`, and `session.wait/unwait` makes `needs_you` fire. Deck repo itself was not touched — remaining gap is Deck-side UI (extension register, worktree creation, land button). (`2026-09-21-deck-bridge-known-limitations.md`)

## Gaps closed after the milestone reports

The milestone documents below are historical snapshots. Later reliability
work closed these previously recorded gaps:

- `ports.named` can no longer override the reserved `PORT` value.
- `cw session rm` and `cw session kill --rm-worktree` dispose leased cache
  directories and copied databases before deleting their lease records.
- A squash merge whose commits produce no staged diff is a successful no-op,
  not a false `LAND_MERGE_FAILED`.
- `cw land all` re-fetches convergence status after each successful land
  instead of acting on one stale initial snapshot.
- The boot-time orphan sweep reclaims only worktrees under `.crossweave/`. It used
  to reclaim every unclaimed worktree `git worktree list` reported, which included
  worktrees the user made by hand — so the first `cw` command run from a repo root
  destroyed the developer's own in-progress worktrees, uncommitted work included.
  A worktree outside `.crossweave/` is now never crossweave's to delete.
  (`2026-09-19-orphan-sweep-scope.md`)

## Full list, per milestone

- `2026-08-10-m0-known-limitations.md`
- `2026-08-10-m1-known-limitations.md`
- `2026-08-10-m2-known-limitations.md`
- `2026-08-11-m3-known-limitations.md`
- `2026-08-12-m4-known-limitations.md`
- `2026-08-12-m5a-known-limitations.md`
- `2026-08-13-m5b-known-limitations.md`
- `2026-08-13-m6a-known-limitations.md`
- `2026-08-14-m6b-known-limitations.md`
- `2026-09-26-audit-fixes-known-limitations.md` — gateway fail-closed, E2E fail-closed/AAD, gc keeps unlanded work, daemon socket watchdog; working browser client (control-token viewers decrypt in-browser; read-token viewers cannot)
- `2026-09-26-terminal-pane-known-limitations.md` — cockpit Terminal pane: a shell in a session's worktree, sandboxed but not guarded by Radar; cockpit-only, ephemeral
- `2026-09-26-deck-parity-known-limitations.md` — agent catalog (only Claude guarded), resume/latest words from agents' private logs, sandbox network on by default, tabs/splits/file/browser panes, Settings
- `2026-09-26-command-first-known-limitations.md` — create ≠ start (launch line, per-session flags, local-only), ⌘K command bar, Changes pane (commits only, 512 KB), review fixes; Telex duplication unconfirmed; TUI key hints and web palette open
- `2026-09-27-shell-sessions-known-limitations.md` — sessions are a worktree + the user's shell; Radar, tiers, agent adapters, MCP, sandbox and spend removed (tag v0.3-radar); no pre-write collision signal, stale `--agent` flags silently name the session
- `2026-09-27-deck-grade-ui-known-limitations.md` — status inferred from the shell (asked is a heuristic, agents only under the session shell), many projects per window (a daemon per open project; the reload on switch is gone, see live-projects), Deck-style rail/chrome
- `2026-09-27-launchers-known-limitations.md` — launchers typed into the session shell (availability = program on the login PATH, or an alias/function of the login shell, read once per daemon); panes use Unicode 11 widths, welcome without a project, Settings need a project open
- `2026-09-27-project-tools-known-limitations.md` — sessions default to the project folder; Delete… for sessions; shells drop inherited agent-session identity (by name); project/session menus, display names/colors/defaults in window storage, git counts refresh on list, closing a project leaves its daemon running, sandboxed tests can orphan daemons
- `2026-09-27-live-projects-known-limitations.md` — every shown project keeps a live view (no reload on switch, hidden terminals stream); 6 live views max, hidden scrollback in RAM, tabs within a project still re-attach, one confirm at a time
- `2026-09-27-terminal-import-known-limitations.md` — Settings → Appearance (installed fonts, text size) and Terminal imports Ghostty / iTerm2 font, size, colors, cursor, Option key; primary font only, several Ghostty/iTerm options unmapped, no config-file includes, dark variant only, one-time import
- `2026-09-27-cockpit-phase-a-known-limitations.md` — live tabs, ⌘F in terminals, agent status read from its screen (spinner working / green done / amber asking), tokens/cost per worktree session (Claude, Codex; prices user-set; none for sessions in the project folder)
- `2026-09-27-cockpit-phase-b-known-limitations.md` — session notes (schema v13, CLI + rail), rebindable menu shortcuts + list, tmux-like panes (zoom, focus by direction, layouts, swap, break-out, drag); layouts re-attach terminals, moves within a tab only
- `2026-09-27-cockpit-phase-c-known-limitations.md` — app themes System / Dark / Light / From terminal, every theme AA-checked; dark first frame, agent marks unchecked, Dark blocked lightened to #ff7580
- `2026-09-27-gateway-removal-known-limitations.md` — `cw gateway`, E2E output sealing and browser phone access removed (tag `v0.4-remote-web`) for a native iOS app later; leftover gateway token files unused, restart old daemons
- `2026-09-28-plain-folders-known-limitations.md` — Open folder dialog for non-repositories (repos inside, the enclosing repo, Initialize git, Open as a plain folder: sessions in the folder, no worktrees/Land/diff); plain folders from the app only (CW_PLAIN), fast failure when a daemon exits at start
- `2026-09-28-overlap-signal-known-limitations.md` — file-level overlap only; a path may be incidental; the committed half shrinks as the base advances; no rename pairing; the rail lags one redraw (the CLI is fresh); shared/plain sessions take no part — a signal, never a guard
- `2026-09-28-session-hooks-known-limitations.md` — `hooks.sessionSetup` typed into the shell at first start (output only in the pty, marked run when typed not when it succeeds, untrusted shown as a typed comment); `sessionTeardown` best effort on `rm`/`gc`/`kill --rm-worktree`/`land` with `process.env` only; both trusted separately via `cw config trust hooks`
- `2026-09-29-daemon-lifecycle-known-limitations.md` — a daemon that fails to start now exits (75 for the bind-race loser) instead of lingering; the daemon logs to `.crossweave/daemon.log` (socket-loss shutdown names how many sessions it hung up). Sessions still die with the daemon, the socket watchdog still self-destructs ≤5 s after a lost socket, and `git clean -xdf` still removes `.crossweave/` under a running daemon
- `2026-09-29-cockpit-terminal-speed-known-limitations.md` — output coalesced per subscriber in the daemon (≈200x fewer messages on a 7.9 MB flood, echo unchanged) and a WebGL renderer under a budget of 12 contexts; on one small pane WebGL was indistinguishable from DOM. Not a native emulator, no flow control, panes past the budget run DOM, a lost context re-acquires only on the next resize signal, GPU-side cost unmeasured
- `2026-09-29-cockpit-motion-known-limitations.md` — FLIP slide/fade for split, close, swap, move (translate/opacity only, off under reduced motion), tab/project fade-in, rail status and badge transitions; zero long tasks and no dropped frames in a real-window CDP run. Fades are enter-only (the outgoing view is display:none), a closed pane vanishes at once, a resized pane fades rather than glides, a pane moved across tabs is not animated
- `2026-09-29-cockpit-settings-page-known-limitations.md` — the settings dialog is now a window-sized page (seven sections, search that ignores case and diacritics, save-as-you-go through the same daemon call). A refusal shows a "Not saved" banner and keeps the draft rather than reverting; the page overlays the whole window; no Voice section, no Project section, no per-row Reset yet
- `2026-09-29-cockpit-command-bridge-known-limitations.md` — a shell command can make the running cockpit act and get an answer (`bridge.call`/`request`/`respond` through the daemon, `pane.ping` served): closed namespaces, first-come registration, timeouts and caps, fail-closed handlers. One cockpit per workspace, no headless mode, unauthenticated caller (safety is per kind, in the cockpit), a same-user process can register first, an older daemon has no bridge
- `2026-09-29-tmux-command-registry-known-limitations.md` — tmux parity 2B.1: commands with no menu item (listed under "Other", bindable, run from the window's own key listener), Next/Previous Tab and Cycle Pane Layout. macOS only, modifier required, handlers stay in ProjectView, the cycle continues from the last preset applied
- `2026-09-29-tmux-panes-known-limitations.md` — tmux parity 2A: layout reducers moved to `src/core/layout`, move a pane to another tab (drag onto a tab, or its menu), synchronize-panes (fan-out from `onData`, REPORT extended for DECRPM/XTVERSION, banner), vi-style copy-mode. Bracketed-paste/DECCKM mismatch across synced panes, copy-mode is approximate (wide chars, wrapped lines), no scrollback on the alternate screen, no native "Move to Tab ▸" submenu
- `2026-09-29-tmux-keytable-known-limitations.md` — tmux parity 2B: a Ctrl-a prefix (rebindable, unbindable) then one key runs a command, with a hint, scoped to a focused terminal pane, prefix twice types the literal, a recorder for `prefix:<key>` bindings. Ctrl-a is line-start in a shell (double-press or rebind), one level only, an older daemon refuses `prefix:` bindings, IME only unit-tested
- `2026-09-29-terminal-persist-known-limitations.md` — tmux parity 2C: opt-in terminal persistence (off by default): a `terminal` table, snapshots every 30 s and at shutdown, restore under the same id with a "new shell" note, private files (0600/0700) while on, snapshots deleted on close/exit/gc/off. A new shell not the old process, a hard kill loses ≤30 s, snapshots are output at rest, 64 KB raw tail, the stale-DA window is not separately tested
- `2026-09-29-cockpit-pane-bridge-known-limitations.md` — `cw pane list|split|select|zoom|layout|move|sync|close|open` drives the running window through the command bridge, main → renderer round trip; closed kinds, strict validation, the person is asked for close / sync on / open url / open file (no answer = refusal), toasts for the rest. Unauthenticated caller by design, no "always allow", one cockpit per workspace, a same-user process can register first
- `2026-09-30-cockpit-browser-agent-known-limitations.md` — `cw browser list|console|network|dom|shot|navigate|click|type|eval` reads and drives a Browser pane over the command bridge; all decisions in cockpit main: per-pane Off/Read/Control switch (off by default, never persisted), control off localhost and eval anywhere ask a native dialog per command (no answer = refusal), live-origin check, redaction, bounded buffers, page text marked untrusted, screenshots written by main. Scope is the project (a browser pane has no session), dom/shot/eval results are not redacted, page text can carry hostile instructions, a same-user process can register on the bridge first
- `2026-09-30-cw-notify-known-limitations.md` — `cw notify "msg" [--kind done|ask]`: a session (or its agent's hook) says itself it is done or needs an answer; ✓ or amber on the row, the words in the tooltip and the desktop notification, cleared by the next keystroke. Unauthenticated same-user caller, memory only, cleared only by that session's own terminal, no info kind
- `2026-09-30-session-checks-known-limitations.md` — `cw check` / row menu "Run checks": the trusted converge.testCommand in the session's own worktree, verdict chip (`✓ tests` / `✗ tests`, dim when stale) on the rail. Same trust gate as land; memory only; stale by git counts and terminal activity (errs toward stale); tests the worktree not the merge; no lease env; a timeout kills the process tree
- `2026-09-30-session-compare-known-limitations.md` — row menu "Compare with another…": two sessions' committed changes side by side in a modal, shared files marked (`both` / `both · same`), each side's verdict, tests chip and its own Land button. Not a pane, committed work only, "same" is text equality of the changed lines, both ≠ conflict
- `2026-09-30-prompt-composer-known-limitations.md` — ⌘⇧P / pen button: write one prompt, optionally Refine it through the person's own command (Settings → Prompt; only a proposal), send to one or several sessions with an exact preview; agent = one bracketed paste, plain shell = one line only, control characters stripped, Enter only if ticked. Agent detection is a guess, sessions only, draft in memory, no cancel for refine
- `2026-09-28-session-setup-exit-code-known-limitations.md` — the setup hook wrapped in a subshell that emits its exit code as an invisible OSC sentinel, watched from the pty stream; `session.list`'s `setup` field gains `'failed'`; still marked-run-at-type-time not at-success, a hook that never reaches the sentinel line stays unresolved forever, no cockpit badge UI built (parser now carries the field, nothing renders it yet)
- `2026-09-28-session-history-known-limitations.md` — `session_history` (not FK'd to `session`, survives its deletion) recorded on `rm`/`kill --rm-worktree`/`gc`; `session.history` RPC, `cw session history`, cockpit ⌘⇧H dialog; a mere `kill` records nothing, no retention limit, no filter beyond `limit`, cockpit dialog unverified visually
- `2026-09-30-session-presets-known-limitations.md` — Settings → Presets and the new-session picker: one click starts a session with its launcher, extra terminals that each run a command, and a Browser pane on the session's leased port. Commands live only in the user's own settings (no trust step, by design), active project only, needs a leased port for the browser, nothing waits for the server, no rollback
- `2026-09-30-rail-and-status-polish-known-limitations.md` — finished turn leaves no circle once looked at and a quiet shell draws none; the rail keeps the newest answer (out-of-order loads dropped); keystroke echo (≤150 ms, no Enter) is not work; landing asks when the last tests failed; the row shows a `cw notify` message. Echo window is a heuristic, the land warning is advice
- `2026-09-30-settings-dashboard-known-limitations.md` — Cursor-style Settings and a Dashboard (projects, sessions, disk, memory) that only *proposes* stopping or deleting idle work; disk measured in the background (`≥` lower bounds), old daemons need a restart for their figures, clean-up excludes sessions gc would keep, no stop-daemon suggestion, fixed thresholds, UTC 14-day charts
- `2026-10-01-persist-checks-design.md` (limits in `2026-09-30-session-checks-known-limitations.md`) — `cw check` verdicts persisted in `session_check` (schema v18) so the rail's tests chip survives a daemon restart; a running run is never stored, the failing tail (≤ 2000 chars) is, an older `cw` refuses the v18 database
- `2026-10-01-ai-debug-loop-known-limitations.md` — split panes now tracked (pane screen 80×24 until resize; sweep cannot announce a track-less session moved by its pane; app-injected writes count as the user; one agent name per row); `cw hooks install|remove` (claude Stop/Notification, codex notify) with atomic/backup/provenance writes — removal matches fixed args rather than provenance, no provenance lock, session hook route live-verified 2026-10-07, gemini refused as hook-less; `cw debug` bundle with a heuristic error-line detector (RAM only) and a heuristic secret scrubber; Debug pane + send-to-session (refetch on list revision / visible + Refresh; composer preview is the gate; localhost browser-error section live-verified 2026-10-08 with Read restored to Off); live drag-pane preview (same-target re-key only; a cross-tab drag has no preview); Responses view after ⌘⇧P (in-memory only; populated row live-verified 2026-10-08)
**2026-10-07/08 — Roadmap follow-through:** session-shell `cw` commands now route to their owning daemon via reserved `CW_WORKSPACE_ROOT`; live `cw notify` succeeded. The rail tooltip names reported vs inferred status and event age; README now walks through two worktrees. Populated Responses and Debug browser errors from a localhost fixture were verified live; Browser access was restored to Off. Resource caps are bounded and tested, but real-world capacity awaits owner usage.
- `2026-10-08-hardening-round-2-known-limitations.md` — `✗ setup` chip, history filter + 500-row cap, more `cw debug` shapes, opt-in `converge.requireCheck` (daemon-side only; no cockpit skip), lease env for `cw check` (none for a stopped session), Compare shows the pair's trial merge (absent above the pairwise threshold ⇒ "not tried"), Refine cancel, update notice (shares the CLI's `updateCheck`; no in-app update), lazy editor chunk (not yet checked in the packaged app); dashboard thresholds left fixed; the 80×24 "gap" is not an inference bug
- `2026-10-09-session-panel-overview-known-limitations.md` — a count chip on rows with ≥2 session-owned panes expands a list to focus one (unzooms when needed, marks the active pane); Browser remains project-scoped, layouts are reported only by live views, stale entries no-op, terminal numbers follow reading order, expansion is not persisted; other row chips still let Enter/Space reach the row
- `2026-10-10-session-checkpoints-known-limitations.md` — hidden git commits (`refs/crossweave/checkpoints/<session>/<n>`, orphan, from a private index) taken when a recognised agent starts and finishes a turn (+ manual, + pre-restore); `checkpoint.list|take|diff|restore`, `cw checkpoint`, a cockpit "Checkpoints…" dialog. Restore is dry-run by default, saves a return point, moves no HEAD/branch/real index and refuses before touching anything if it would destroy an ignored file or write through a symlink. Ignored files out of scope; plain shells and pane-only agents get no automatic checkpoints; turn boundaries are inferred; 50 kept; 50 MB untracked guard on automatic ones; refs visible to `git log --all`; measured ~100–155 ms per take on 662 files; no schema change
- `2026-10-10-diff-comments-known-limitations.md` — comment on a diff line (Changes pane and Checkpoints dialog) and paste the notes into the session's shell, never pressing Enter; comments live in memory only, a plain shell is refused, a very common line can re-match after a reload, one gutter button per line (not measured on a large diff).
- `2026-10-10-auto-check-known-limitations.md` — opt-in (`checks.autoRun`, off) automatic run of the trusted test command when an agent ends a turn that changed files, plus "Send test failure to shell" (no Enter, tokens redacted); it makes an agent's own work cause a run outside the agent's sandbox, for every project whose command was trusted; turn ends are inferred, change detection misses/over-runs in listed cases, one automatic run at a time.
- `2026-10-10-sensitive-files-known-limitations.md` — labelled badges (`secret`/`automation`/`migration`/`dependency`) and a summary line on the file lists of Changes, Checkpoints and Compare, judged by file NAME only (no content scan), and one Land question for secret-like and automation files (merged with the failing-tests one); only the cockpit's Land button asks, a diff over the 64 MB buffer skips it, a new dependency is badged but not asked about.
- `2026-10-11-settings-polish-check-alert-known-limitations.md` — Settings read alike in every section (no banner, a lead, a titled first card, a folded Details, a steady column, row descriptions cut to one sentence, the auto-run safety words kept in the row) and a desktop alert when a check fails while the window is away: `<session>: tests failed`, exit code and time only, never the output, one per failing run, silent for a first look and a stale verdict, switch on by default. It comes from the window, so only mounted projects raise it; no live Checks status. Also fixes feature 3: failure text is cleaned before it is redacted.
- `2026-10-11-website-known-limitations.md` — a static, dependency-free site in `website/` (home in English and Vietnamese, download, docs built from the README, changelog, a bilingual 404) built by `bun website/build.ts` and deployed to GitHub Pages by `pages.yml`; claims carry their qualifiers and a badge until their release is published, markdown goes through our own allow-listing renderer, release data comes from a committed manifest. Not notarized (the download page says so); docs and changelog English only; Vietnamese unproofread; the workflow has never run; Pages setup, any domain and the release itself are the owner's steps.
- `2026-10-11-website-v2-known-limitations.md` — the story-led home, Security & privacy page and scripted Cockpit demo have launch QA: native controls work without JavaScript, reduced-motion users get no autoplay, and Chromium route/zoom/accessibility and keyboard checks pass. Pages run `38234215498` published and live HTTPS sitemap/canonical/hreflang/robots metadata was checked. Safari normal-motion autoplay and Pause/Play pass a manual smoke check; the full Safari/Firefox matrix and independent Vietnamese human proofreading remain open. Notarization is deferred.
- `2026-10-11-ci-checkpoint-stability-known-limitations.md` — Linux CI excludes Cockpit correctly, and its fake CLI fixtures use portable POSIX `\\033` escapes under `dash`. Five focused PTY tests and all 2,362 root tests pass locally; GitHub Actions runs `38233229200` and `38233978753` pass Linux and macOS Cockpit jobs.
- `2026-10-11-cockpit-live-session-land-known-limitations.md` — explicit clean live-session stop-and-land with daemon pre/post status checks for `running` and legacy `waiting`; unknown convergence stays a separate choice; a write racing shutdown leaves a stopped, preserved worktree. The flow is included in merged PR #3.
- `2026-10-12-post-release-closeout-known-limitations.md` — PRs #3 (`337745e`), #4 (`e32d0d1`), #5 (`ef93afd`), and #6 (`7ed3a13`) merged linearly; CI runs `38233978753`, `38236079238`, `38236416284`, `38236698694`, `38237502724`, and `38238096754` passed before main run `38238889755` reproduced a partial `.git` fixture copy failure. PR #7 replaces filesystem copy with `git clone --no-hardlinks`; local typecheck and 2,363 tests pass, as does PR CI run `38240382394`. Pages runs `38234215498`/`38236698702` pass, and live HTTPS sitemap metadata is correct. Safari smoke playback passes, Firefox remains untested, independent Vietnamese human proofreading is still open, and notarization remains deferred.
- `2026-10-12-website-search-description-known-limitations.md` — concise bilingual home-page search descriptions are enforced at 160 characters across indexable pages; search engine snippets and Search Console results remain unverified, and Vietnamese copy still needs independent proofreading.
- `2026-10-13-website-full-bilingual-known-limitations.md` — all 22 indexable routes and current releases v0.3.0–v0.6.0 have EN/VI counterparts with paired metadata and localized shell links; Vietnamese technical copy still needs independent proofreading, and manually maintained translations can drift from canonical English sources.
