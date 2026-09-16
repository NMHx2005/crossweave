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

**Only `Edit`/`Write` tool calls are intercepted.** Anything a session does
through the `Bash` tool — `sed -i`, `> file`, `git checkout -- file`, or an
agent-invoked script — is invisible to both Safe Mode and the Collision
Radar. (M5a)

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
that risk; it does not sandbox the process.

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
  package in v1. The CLI TUI (`cw tui`) remains the cross-platform dashboard.

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
