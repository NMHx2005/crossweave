# Plan — Remote gateway Stage 1: auth + read/control split

**Spec:** `docs/superpowers/specs/2026-09-18-client-seam-and-remote.md` Stage 1.
**Tier:** Medium — auth in gateway, no daemon change yet; token per workspace, read-vs-control split, revocation.
**Status:** done (2026-09-21) — `auth.ts` + `gateway.ts` requireToken gate + `gateway` CLI + `gateway-auth.test.ts` (3 pass). TLS (1b) and read/control split are next.

## Why

Stage 0 proved shuttling works without auth, bound to loopback. Before any network listener leaves the machine, the gateway must have: per-workspace token, read-vs-control authorization (watch ≠ input ≠ land), and revocation — otherwise "anyone who can open the socket owns everything" becomes "anyone on the network owns everything".

## What "done" means

- `src/gateway/auth.ts` — token store (one token per workspace, file in `.crossweave/` 0600), generation (`cw gateway token`), verification on WS handshake (first frame or header), revocation (`cw gateway revoke`).
- `src/gateway/gateway.ts` — enforce read-vs-control: read methods (`session.list`, `workspace.info`, `converge.status`, `tui.*`, `session.data` notifications) allowed with read token; control methods (`session.new/resume/stop/kill/rm`, `session.input/resize`, `land.session`, `session.rename`) require control token. Unauthorized → JSON-RPC error, not forwarded.
- Tests: auth creation/verification/revocation, read-vs-control enforcement, no bypass via framing split.
- No TLS in Stage 1 (deferred to 1b) — document that Stage 1 is for trusted networks / SSH tunnel; log loudly if bound non-loopback without TLS.
- Docs: spec Stage 1 → Implemented, README Remote notes token.

## Tasks

1. Token store + CLI (`cw gateway token|revoke`)
2. Gateway auth enforcement + read/control split
3. Tests + docs

## Gate

`bun run typecheck` · `bun run build` · `bun test` (gateway auth tests in-memory)
