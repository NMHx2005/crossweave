# Stage 3 Hosted Relay — Plan

**Goal:** Hosted dumb forwarder with workspace routing.

**Spec:** `docs/superpowers/specs/2026-09-24-stage3-hosted-relay-design.md`

**Tasks:**
1. Add Worker entry `src/gateway/relay-worker.ts` (fetch handler routing by workspaceId, WS upgrade to createRelay pair) + doc `docs/superpowers/specs/2026-09-24-stage3-hosted-relay-design.md` already.
2. Extend `src/gateway/relay.ts` doc for hosted contract if needed.
3. Add `tests/gateway/relay.test.ts` if missing (dumb forward assert).

**Gate:** typecheck · build
