# Persisting `cw check` verdicts — design

## Problem

`CheckRunner` keeps a session's last test verdict (pass / fail, when, how long, the end of a failing run's output, and the git counts
it judged) in the daemon's memory. A daemon restart forgets every verdict, so the rail's `✓ tests` / `✗ tests` chip disappears exactly
when people restart daemons to pick up a new version.

## Decision

Store a **finished** verdict in a new table, `session_check` (migration **v18**, append-only):

`session_id` (PK, FK → `session` ON DELETE CASCADE), `state` (`pass`|`fail`), `at`, `finished_at`, `ms`, `code`, `tail`, `changed`, `ahead`.

- A verdict dies with its session (cascade); nothing outlives a deleted session.
- `running` is never stored: a run does not survive its daemon. Starting a run deletes the old row first, so an interrupted run
  never resurrects the verdict it was replacing.
- After a restart the verdict is still pinned to the git counts it judged and turns *stale* on the same rules (counts moved, or the
  terminal was active after `finished_at`). The daemon's terminals are fresh, so activity can only make it stale, never fresh.
- The failing run's tail (≤ 2000 chars) is stored: it lives in the project's own `.crossweave/state.db`, next to the same
  repo's other data, and is what the person needs to see after a restart. Recorded as a limitation.

## Alternatives rejected

- A JSON file per project: a second store to keep consistent with session deletion; the cascade is free in SQLite.
- Persisting `running`: it would show a run that no longer exists.

## Risk

A project database at v18 is refused by a **v17 build** ("Upgrade crossweave"). After the first restart with this version, an
older `cw` on the PATH stops working in that project until `cw update`. Additive table only; nothing existing changes.
