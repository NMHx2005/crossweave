# Horizon D — Sandbox + Gateway Hardening — Known Limitations

**Date:** 2026-09-24
**Commits:** `ab8ed61` (spec/plan), `5322f7c` (relay+sandbox docs), `accafc2` (e2e helpers)
**Design:** `docs/superpowers/specs/2026-09-24-horizon-d-sandbox-gateway-hardening-design.md`
**Plan:** `docs/superpowers/plans/2026-09-24-horizon-d-sandbox-gateway-hardening.md`

## What is built

- Spec + plan for sandbox parity + E2E + relay hardening.
- `src/gateway/relay.ts` dumb forwarder doc — ends enforce, relay only forwards.
- `src/isolation/sandbox.ts` parity note for CI.
- `src/gateway/e2e.ts` — `deriveKey` (HKDF-SHA256) + `encrypt`/`decrypt` (aes-256-gcm, 12B nonce) via `node:crypto`, stdlib only, no `.node`.

## Gaps still open

- CI `sandbox-linux` job: `ci.yml` has job skeleton but local hook blocks `sudo` text — needs `sudo apt-get` lines restored (via manual push outside sandbox) to run `bubblewrap` + `ripgrep` on ubuntu-latest.
- `session.data` E2E not yet wired into `src/daemon/methods.ts` RPC — helpers exist but no envelope on the wire; plaintext fallback still.
- Relay deploy (Worker) + workspace routing + presence beyond closeBoth — deferred (out-of-repo infra).
- Windows packaging deferred until `cwd` on Windows.
