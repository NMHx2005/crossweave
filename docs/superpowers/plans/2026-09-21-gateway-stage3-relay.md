# Plan — Gateway Stage 3: hosted relay / multi-machine

**Spec:** `docs/superpowers/specs/2026-09-18-client-seam-and-remote.md` Stage 3.
**Tier:** Large — relay that forwards without reading session content (E2E), multi-machine coordination, deliberate trust boundary.
**Status:** in progress — dumb forwarder (`src/gateway/relay.ts` + `gateway-relay.test.ts`) built; E2E + infra remain deferred.

## Why

Stage 2 lets a browser on the same network (or via SSH tunnel) reach the daemon. Stage 3 removes the "same network" requirement — agents and code on someone else's infra, a relay that forwards frames but cannot read `session.data` content. This is a different trust question (the relay is untrusted), so E2E encryption and per-session keys are required before a hosted relay is safe.

## What "done" would mean

- Relay process that forwards `ClientTransport` frames between two WebSockets without decrypting `session.data` (E2E via per-session key derived from the workspace token).
- Multi-machine session coordination (which daemon owns which session) — likely via workspace id routing.
- No change to the daemon's method table; the same `ALLOWED_METHODS` allowlist.
- Docs: spec Stage 3 → Implemented, README "Remote (hosted)" section.

## Why deferred

- Stage 2 via `ssh -L` / Tailscale already covers "control my sessions from my laptop" without trusting a third party.
- E2E design needs a key-distribution ceremony that must not weaken Stage 1's token model.
- Implementation touches infra (hosted relay deployment) — out of scope for the open-source core until the local story is solid.

## Next step when un-deferred

1. Design E2E for `session.data` (per-session symmetric key, derived, never leaves the two ends).
2. Relay as a dumb forwarder (no `ALLOWED_METHODS` enforcement — ends enforce).
3. Workspace routing + presence.

## Gate

`bun run typecheck` · `bun run build` · relay E2E tests (in-memory, no network).
