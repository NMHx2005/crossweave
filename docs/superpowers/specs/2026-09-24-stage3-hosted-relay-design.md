# Stage 3 Hosted Relay — Design

**Date:** 2026-09-24
**Horizon:** Stage 3 hosted (after D/E/F)
**Tier:** Small — hosted forwarder, no DB migration, no native modules.

## Goal

Deploy `src/gateway/relay.ts` dumb forwarder as hosted relay (Cloudflare Worker `api.deck.spacevibe.dev` style) — workspace routing via `RelayOptions.workspaceId`, presence via `onClose`/`onError`/`onEnd` closeBoth. E2E stays at ends (`src/gateway/e2e.ts` HKDF + aes-256-gcm), relay never inspects `session.data`.

## Non-goals

- No auth at relay — `ALLOWED_METHODS`/`READ_METHODS`/`CONTROL_METHODS` enforced at daemon + gateway ends.
- No DB change.

## Design

- Relay is stateless forwarder `createRelay(a,b,opts)`: `onData` both ways, `closeBoth` on any close/end/error. No JSON.parse, no allowlist.
- Hosted infra: Worker routes by `workspaceId` query/header, upgrades to WS, pairs transports.
- Gateway `createGatewayTransport` already shuttles WS ↔ unix socket with auth gate (`requireToken` -> `authedKind`).

## Gate

bun run typecheck · bun test --concurrency 1 · bun run build
