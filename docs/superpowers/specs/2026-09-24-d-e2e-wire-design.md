# Horizon D Remaining — session.data E2E Wire — Design

**Date:** 2026-09-24
**Horizon:** D remaining
**Tier:** Small — wire existing helpers to the wire, no new RPC, no native.

## Goal

`session.data` E2E between daemon ↔ client through relay dumb forwarder. Helpers `src/gateway/e2e.ts` already exist (HKDF+ aes-256-gcm, stdlib). Wire: daemon encrypts `chunk` in `src/daemon/runtime.ts` when per-workspace key exists; client decrypts in `src/client/rpc-client.ts` (or `ws-transport`) before `handleMessage`. Relay `src/gateway/relay.ts` stays dumb.

## Key

Per-workspace symmetric key derived from `gateway.token` (0600) via `deriveKey(token, workspaceId)` cached per-workspace in `methods.ts`. Fallback plaintext when no token (existing behavior) — zero break.

## Gate

bun run typecheck · bun test --concurrency 1 · bun run build + sandbox-linux CI green
