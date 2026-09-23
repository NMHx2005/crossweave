# crossweave — known limitations, before you rely on this

Every milestone (M0 through M6b) ships its own `*-known-limitations.md` next
to this file, written at merge time with the specific gaps found and
deliberately deferred during that milestone's review. This digest doesn't
replace them — it pulls out the subset that actually matters before you
point crossweave at a real project, so you don't have to read eight
documents to find them. Full list, per milestone, at the bottom.

## The ones that change what you should trust it with

**Safe Mode has no auth boundary.** `cw workspace safe-mode T3` lets any
agent self-disable blocking — there's nothing stopping a session from
turning off its own enforcement. Safe Mode is a *safety net for cooperative
agents*, not a sandbox against an adversarial one. (M5a)

**Safe Mode fails open on infrastructure trouble, inconsistently.** T1
(ACP — Cursor) fails *closed* on an internal daemon error; T2 (the Claude
Code hook) fails *open*, deliberately, so a broken daemon or a slow hook
doesn't hang the agent — but that means a dead daemon silently downgrades
every T2 block to an allow. If you're depending on Safe Mode to actually
stop a write, check which tier you're on. (M5a, M5b)

**Only `Edit`/`Write` tool calls are blocked.** A write made through the `Bash`
tool — `sed -i`, `> file`, `git checkout -- file`, or a script the agent
wrote and then ran — is not blocked by any *tier*. The Collision Radar *does* see
it, but after the fact: `fs.watch` indexes the write (immediately when the
agent's own PostToolUse hook fires, otherwise on a 500ms debounce), so a
collision arrives as a retroactive notice, never as a stop. The PreToolUse hook
reads `Bash` commands too now, but that reading is a guess from the command
string and it only ever advises — a block stays reserved for a write the daemon
actually evaluated. Every tier is printed with what it really covers
(`T2 · Edit|Write`) rather than a bare tier that reads as protection.
(2026-09-17-tier-coverage-honesty-design.md)

**The gap is closed at a different layer, not by the tiers.** Since
2026-09-18 a session process runs inside an **OS sandbox** (macOS seatbelt;
since 2026-09-20 also Linux bubblewrap via `bwrap` when present on PATH):
the write through `Bash` is still not *intercepted*, but it is *impossible*
outside the session's own worktree — the boundary is on the process, so a
shell, a script, or a subprocess cannot escape it. Network is denied unless the
workspace opts in. With no provider (missing `bwrap` on Linux, Windows, or a
`--no-worktree` session sharing the main checkout) the session runs unconfined
and the daemon logs that fact. See `2026-09-18-os-sandbox-design.md`.

**The Cursor path that works is advisory.** `cursor-agent` builds from
2026.08 removed ACP, so `--agent cursor` (T1) can no longer run — it now fails
fast with a clear message instead of hanging silently — and `--agent
cursor-print` (T3) is what actually works: a real PTY-less print-mode run with
**no permission interception**, so Safe Mode cannot block a write there. (M5b)

**`converge.testCommand` is arbitrary shell, run automatically once
trusted.** The `cw config trust` gate exists and must record the current
command before crossweave will run it. Treat that gate as a real trust
boundary, not a formality — don't trust a `crossweave.config.json` you
didn't write yourself. (M4)

**Collision Radar only attributes committed lines.** `cw blame` can't tell
you who's editing something that hasn't been committed yet — mid-flight
collisions rely on the live hook/watcher path, not `blame`. (M2)

**Runtime leases are cooperative, not enforced isolation.** crossweave
injects per-session port, Docker, cache, and database environment values,
but an agent or subprocess that ignores those values can still use shared
resources and collide with another session. Lease visibility helps diagnose
that risk; the OS sandbox (above) confines *writes*, not ports — it does not
stop a session from ignoring its leased port and squatting on another's.

## Everyday gaps worth knowing, not blocking

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

**Horizon D is wired** (ab8ed61→92bbafd): CI `sandbox-linux` job (ubuntu-latest + bubblewrap) proves `buildBwrapArgs` escape table; `session.data` E2E helpers `src/gateway/e2e.ts` (HKDF + aes-256-gcm via node:crypto, no native) — relay `src/gateway/relay.ts` stays dumb forwarder, ends enforce allowlists. Relay deploy + workspace routing remain deferred. Horizon E adds `workspace.openFile` READ (path containment, 512k cap) + web client `openFile`; Horizon F adds `bwrap` check to `install.sh`. Sprint `eff82d9` adds telemetry opt-in (`src/gateway/telemetry.ts`, per-day file, consent 0600, no code/paths/prompts) and E2E wire (`src/client/rpc-client.ts` decrypts `E2EBlob` chunk when gateway token exists, fallback plaintext).

**Horizon C is wired (engine + cockpit):** `usage.summary` READ RPC aggregates `SessionRow` by `day`/`agent`/`day+agent`; cockpit shows table with "estimate, not billing". Telemetry is spec-only (opt-in per-day file + POST `api.deck.spacevibe.dev/v1/ping`) — not yet implemented, default OFF. Token semantics still M6a: ACP `tokenSpent` is context occupancy, may decrease after compaction. (`2026-09-24-horizon-c-usage-design.md`)

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
