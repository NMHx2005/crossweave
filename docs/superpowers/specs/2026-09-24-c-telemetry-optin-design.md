# Horizon C Remaining — Telemetry Opt-In — Design

**Date:** 2026-09-24
**Horizon:** C remaining of long roadmap
**Tier:** Small — one module + consent gate, no DB migration, no native modules.

## Goal

First-party telemetry opt-in (default OFF) — per-day buffer `telemetry.json` under `.crossweave/` (atomic tmp+rename), flush POST `api.deck.spacevibe.dev/v1/ping` only when consent true, never sends code/paths/prompts. UI toggle in Settings → Privacy (cockpit), CLI flag for TUI.

## Non-goals

- No always-on, no account, no per-turn granularity.
- No server-side aggregation.

## Design

- `src/gateway/telemetry.ts`: `record(event)` appends to per-day file when `consent=true`; `flush()` batches per-day and POSTs (best-effort, no throw). Consent stored in `crossweave.config.json` or `.crossweave/telemetry-consent.json` (0600, simple boolean), default false.
- `src/daemon/methods.ts`: no RPC needed — telemetry is client-side file, daemon does not need to know.
- `src/gateway/e2e.ts` already has `deriveKey/encrypt/decrypt` — next step wires it to `session.data` on the wire (see D spec).

## Gate

bun run typecheck · bun test --concurrency 1 · bun run build
