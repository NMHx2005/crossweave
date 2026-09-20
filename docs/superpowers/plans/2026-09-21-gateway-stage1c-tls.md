# Plan — Gateway Stage 1c: TLS for non-loopback

**Spec:** `docs/superpowers/specs/2026-09-18-client-seam-and-remote.md` Stage 1c.
**Tier:** Small — gateway server option, no daemon change.
**Status:** done (2026-09-21) — `server.ts` validate + `createGatewayHttpServer` (http/https), CLI `cw gateway serve`, `gateway-tls.test.ts` 3 pass.

## Why

Stage 1/1b tokens prove who and what, but bytes still travel cleartext if the gateway ever binds beyond loopback. Stage 1c makes non-loopback safe by requiring TLS (or an explicit `--insecure` + loud log), so a user who puts the gateway on `0.0.0.0` does not accidentally expose tokens and session content.

## What "done" means

- `src/gateway/server.ts` — `startGateway({ socketPath, port, host, cert, key, token })` using `ws` or native `WebSocketServer` with TLS; loopback without TLS allowed, non-loopback without TLS refuses to start unless `--allow-insecure` (logs loudly).
- `wsTransport` supports `wss://` (no code change — platform WebSocket already does).
- CLI: `cw gateway serve --port --host --cert --key [--token] [--allow-insecure]`.
- Tests: TLS flag gating, loopback allowed, non-loopback without cert rejected.
- Docs: spec Stage 1c → Implemented.

## Gate

`bun run typecheck` · `bun run build` · `bun test` (gateway TLS gating tests in-memory)
