# Plan — Gateway Stage 1b: read/control split + audit log

**Spec:** `docs/superpowers/specs/2026-09-18-client-seam-and-remote.md` Stage 1b.
**Tier:** Small — gateway-only, no daemon change.
**Status:** done (2026-09-21) — per-kind tokens (`gateway.token`/`gateway.read.token`), `READ_METHODS` split + `Forbidden` on read→control, `gateway.audit.log`, CLI `cw gateway token|revoke [--read|--control]`, `gateway-auth.test.ts` 4 pass.

## Why

Stage 1 token proves "who can open the gateway", but not "what they may do" — a phone that should only watch a pane must not be able to `land` or `kill`. Stage 1b adds read vs control authorization + an append-only audit line per forwarded call, so a compromised read token cannot become a control token and every control action is traceable.

## What "done" means

- `src/gateway/auth.ts` — two token kinds (`read` + `control`, or one token with two capabilities via `tokenKind`); `issueGatewayToken(kind)` + `verifyToken` returns kind.
- `src/gateway/gateway.ts` — after auth, enforce: read token may only forward `READ_METHODS`; control token may forward all `ALLOWED_METHODS`. Control attempt on read token → `-32000` error, not forwarded. Each forwarded call appends to `gateway.audit.log` (timestamp, method, session if present).
- CLI: `cw gateway token [--read|--control|--rotate]` and `cw gateway revoke [--read|--control]`.
- Tests: read token blocked on control, control token passes, audit log written.
- Docs: spec Stage 1b → Implemented.

## Gate

`bun run typecheck` · `bun run build` · `bun test` (gateway-auth in-memory)
