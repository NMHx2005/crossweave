# Plan — Remote gateway Stage 0 (local WebSocket gateway over the unix socket)

**Spec:** `docs/superpowers/specs/2026-09-18-client-seam-and-remote.md` (Stage 0).
**Tier:** Medium — new gateway process, reuses `src/client/transport.ts` + daemon's unix socket; no daemon change, no auth yet (auth is Stage 1).
**Status:** done (2026-09-21) — `src/gateway/ws-transport.ts` + `gateway.ts` + `tests/client/gateway.test.ts` (3 pass), allowlist-gated, no daemon change.

## Why

The client seam (`src/client/transport.ts` + `DaemonClient.attach`) already makes remote "one more transport", proven over an in-memory transport. Stage 0 proves the whole flow end-to-end (bytes → gateway → unix socket → daemon → back) without changing the daemon's trust boundary — the gateway is local, the daemon stays on 0600/0700, and no network listener is exposed without an explicit opt-in.

## What "done" means

- `src/gateway/` (or `src/remote/gateway.ts`) — a WebSocket gateway that bridges `ClientTransport` (unix socket side) ↔ WebSocket (client side), reusing the daemon's closed channel allowlist shape for inbound validation (no new RPC surface).
- `DaemonClient` over `wsTransport` reaches the same method table as the unix-socket path; a browser/CLI client can `DaemonClient.attach(wsTransport)` and call `session.list` etc.
- No auth / no TLS yet — the gateway binds to `127.0.0.1` by default and refuses non-loopback unless `gateway.allowRemote` is explicitly set (and then logs loudly). Stage 1 will add token + read-vs-control split.
- Tests: in-memory WebSocket round-trip (gateway ↔ unix mock) + framed JSON-RPC correctness; no real network in tests.
- Docs: spec Stage 0 → Implemented, README "Remote" section (local gateway, no auth yet).

## Non-goals

- Auth, TLS, multi-machine relay (Stage 1+), hosted service.
- Exposing the no-auth socket over TCP (forbidden by spec).
- Changing the daemon's listener — it stays unix-only in Stage 0.

## Tasks

### 1. Gateway transport ✓ `wsTransport` (platform WebSocket) + `createGatewayTransport` shuttling + allowlist `ALLOWED_METHODS` + `onEnd`/`onClose` propagation

- Define `wsTransport(url)` implementing `ClientTransport` (uses `ws` or `WebSocket` — choose one, no native deps).
- Build `gateway.ts`: `createGateway({ socketPath, wsPort })` — accepts WebSocket connections, for each creates a unix-socket transport to the daemon and shuttles frames both ways with backpressure; validates inbound frames against the daemon's RPC allowlist shape (reject unknown method).

### 2. Wiring + CLI — deferred: `cw gateway start` CLI wiring is Stage 0.5 (needs port derivation + lifecycle); gateway core is done and test-covered

- `cw gateway start|stop|status` (or `cw gateway` subcommand) — starts the gateway as a child of `cwd` or standalone; default `ws://127.0.0.1:<derived-port>` derived from workspace id (reuse lease port derivation so it doesn't collide).
- Ensure `close`/`onEnd` propagation so a half-closed client fails pending calls rather than hanging (same guarantee as the unix transport).

### 3. Tests + docs ✓ `tests/client/gateway.test.ts` (shuttle + unknown-method reject + allowlist) + spec Stage 0 → Implemented

- `tests/client/gateway.test.ts` — framed round-trip over in-memory WebSocket pair, `onEnd`/`onClose` propagation, unknown-method rejection.
- Docs: spec Stage 0 status + README Remote section.

## Gate

`bun run typecheck` · `bun run build` · `bun test` (outside sandbox for socket tests; gateway tests are in-memory and pass inside).
