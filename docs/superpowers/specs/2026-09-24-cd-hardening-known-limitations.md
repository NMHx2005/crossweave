# C/D Hardening Sprint — Known Limitations

**Date:** 2026-09-24
**Commit:** `eff82d9`
**Designs:** `2026-09-24-c-telemetry-optin-design.md`, `2026-09-24-d-e2e-wire-design.md`

## What is built

- Telemetry opt-in: `src/gateway/telemetry.ts` — `getConsent`/`setConsent` (0600), `record` per-day `telemetry-{day}.json` (tmp+rename), `flush` POST to `api.deck.spacevibe.dev/v1/ping` when consented. Only `kind`/`agentKind`/`at` recorded, never code/paths/prompts. Default OFF.
- E2E wire: `src/client/rpc-client.ts` unwraps `session.data` chunk when it looks like `E2EBlob` (nonce/ct/tag) using `deriveKey(token, cwd)` + `decrypt`.

## Gaps

- E2E wire uses `process.cwd()` as salt fallback — per-workspace `workspaceId` not in `session.data` notification, so key derivation is cwd-keyed. Full per-workspace routing needs workspaceId in payload or per-workspace key cache.
- `src/daemon/runtime.ts` encrypt hook is placeholder — daemon still sends plaintext `chunk`; E2E helpers exist but encrypt not wired on send. Decrypt path is ready.
- Telemetry `flush` is best-effort, no retry, no auth header.
- Browser tabs (Horizon E remaining) still deferred.
