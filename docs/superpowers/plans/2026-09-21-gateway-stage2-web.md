# Plan — Gateway Stage 2: web pane + notifications

**Spec:** `docs/superpowers/specs/2026-09-18-client-seam-and-remote.md` Stage 2.
**Tier:** Medium — web client over `wsTransport` + existing notify seam, no daemon change.
**Status:** done (2026-09-21) — `src/gateway/web/client.ts` + `index.html` + `gateway-web.test.ts` 1 pass, `DaemonClient.attach(wsTransport)` + `tui.event`nt`.

## Why

Stages 0–1c proved transport + auth + TLS gating. Stage 2 makes it usable from a browser/phone: a web pane (xterm.js, same as Cockpit) that `DaemonClient.attach(wsTransport)` to `session.list`/`attach`/`input`/`resize`, plus notifications via the existing `notify` seam (`tui.event`).

## What "done" means

- `src/gateway/web/` — static web client (HTML + `client.ts`): connect `wss://` with token, list sessions, attach xterm pane, send input/resize, show `tui.event` notifications.
- Gateway `server.ts` serves the static client at `/` when a `webRoot` is configured.
- Reuses `wsTransport` + `DaemonClient` + token layer; no new RPC.
- Tests: web client list/attach flow over in-memory transport.
- Docs: spec Stage 2 → Implemented.

## Gate

`bun run typecheck` · `bun run build` · `bun test`
