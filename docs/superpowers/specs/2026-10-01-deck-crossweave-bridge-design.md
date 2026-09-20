# Deck × crossweave bridge — design

**Date:** 2026-10-01
**Status:** draft
**Scope:** Horizon A of the Long Roadmap — one app, one engine. Deck's Stage + Rail are the UI, crossweave's `cwd` + Radar + Convergence are the engine, joined over `ClientTransport`.

## 1. Shape

A sidecar/extension process `src/deck/bridge.ts` that speaks `DaemonClient` (unix socket locally, `wsTransport` remotely) and exposes a Deck-friendly model: `listWorktrees()` → worktree cards, `attentionBySession` → rail marks, `land(sessionId)` → evidence-gated land, `onEvent` → `tui.event` feed.

Deck already has worktree cards with heading/color/dot/selected frame and a worktree creation flow (1-min checkout, partial-checkout guard) — we map crossweave `worktreePath`/`branch` onto that card, not the other way around.

## 2. Attention mapping

crossweave `deriveAttention` (working/needs_you/blocked/ready/unknown/conflict) → Deck rail (working/asked/failed) + latest tail words from `session.data`. `needs_you` is currently unreachable (`waiting` never written) — wire the first real `waiting` signal in this horizon.

## 3. Non-goals

No fork of the daemon's method table, no new RPC, no hosted relay — those are Horizons D/E.

## 4. Gate

`bun run typecheck` · `bun run build` · `bun test` + Deck dev with 2 live sessions.
