# Horizon C — Usage Accounting — Known Limitations

**Date:** 2026-09-24
**Commits:** `87ae992` (spec), `bea4bc6` (engine), `0d8759c` (cockpit)
**Design:** `docs/superpowers/specs/2026-09-24-horizon-c-usage-design.md`
**Plan:** `docs/superpowers/plans/2026-09-24-horizon-c-usage-accounting.md`

## What is built

- `usage.summary` READ RPC — aggregates `SessionRow` by `day`/`agent`/`day+agent`, read-only.
- Cockpit usage pane — table grouped by day+agent, cost labeled as estimate.

## Gaps carried / still open

- Telemetry opt-in (per-day `telemetry.json` + POST `api.deck.spacevibe.dev/v1/ping`) is spec-only, not implemented — default OFF, no file, no POST.
- No per-turn granularity — both sources are cumulative session totals (M6a).
- No authoritative billing — `costUsd` is client-side estimate, must be labeled as such.
- ACP `tokenSpent` is context occupancy, may decrease after compaction — `tokens` column is not monotonic for T1 sessions (M6a carry).
- No Deck local log reader — only `SessionRepo` rows; Deck logs integration is best-effort when available.
- No TUI surface for usage — CLI remains `cw session list`; cockpit is the only UI.
