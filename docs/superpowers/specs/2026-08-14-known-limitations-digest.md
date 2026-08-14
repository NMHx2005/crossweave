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
trusted.** `cw config trust` is a real trust boundary, not a formality —
don't trust a `crossweave.config.json` you didn't write yourself. (M4)

**Collision Radar only attributes committed lines.** `cw blame` can't tell
you who's editing something that hasn't been committed yet — mid-flight
collisions rely on the live hook/watcher path, not `blame`. (M2)

## Everyday gaps worth knowing, not blocking

- Desktop notifications are **macOS only**; other platforms get a silent
  no-op, not a degraded warning. (M6b)
- Notification click-through needs `terminal-notifier` (an optional
  Homebrew dependency) and always opens Terminal.app, never your actual
  terminal. (M6b)
- Budget/burn numbers are **not authoritative billing data** — they're a
  local estimate, useful for an at-a-glance sense of spend, not for
  invoicing. (M6a)
- A killed session's name can't be reclaimed immediately. (M0)
- No TUI yet — see the README's Status section.

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
