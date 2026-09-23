# Horizon D — Sandbox + Gateway Hardening — Design

**Date:** 2026-09-24
**Horizon:** D of `docs/superpowers/plans/2026-09-21-long-roadmap-spacevibe-crossweave.md`
**Tier:** Medium — sandbox CI parity + gateway E2E + relay hardening, no DB migration, no native modules.
**Status:** design — precedes `docs/superpowers/plans/2026-09-24-horizon-d-sandbox-gateway-hardening.md`

## 1. Goal

Khóa trust boundary trước khi Stage 3 hosted: mọi write ngoài worktree bị chặn trên cả macOS (seatbelt) và Linux (bwrap), đo bằng integration suite thật trên CI; `session.data` E2E giữa daemon ↔ client (relay chỉ forward bytes, không inspect); relay infra dumb forwarder với workspace routing + presence, ends enforce `ALLOWED_METHODS`.

## 2. Non-goals

- Không authoritative billing, không per-turn usage (thuộc Horizon C).
- Không browser tabs / file explorer (Horizon E).
- Không Windows packaging — `cwd` vẫn POSIX-only (Bun pty + unix socket).
- Không fork daemon method table — chỉ thêm E2E envelope, không thêm RPC mới ngoài `session.data` crypto.

## 3. Sandbox parity

- `src/isolation/sandbox.ts` đã có `buildBwrapArgs` + `planSandbox` branch, gated `which bwrap`, `TMPDIR` private, narrow git binds — escape table 7 probes đã harden (Horizon A).
- Còn thiếu: CI job `ubuntu-latest` chạy `bwrap integration (real bwrap)` thật — hiện skip trên macOS. Thêm job `sandbox-linux` (install bubblewrap, `bun test tests/isolation/sandbox.test.ts`), cache `bun install`. Không thay đổi provider logic.

## 4. Gateway Stage 3 E2E

- Per-workspace symmetric key derived từ `gateway.token` (HKDF SHA-256, salt = workspaceId, info = `crossweave session.data`) — key ở filesystem `0600` (`crossweaveDir`), không qua relay.
- `session.data` payload được mã hóa (AEAD, e.g. `aes-256-gcm` via `node:crypto` — stdlib, không native `.node`) tại daemon trước khi write ra transport, client giải mã sau khi nhận. `tui.event`/`tui.invalidate` không E2E (notifications), chỉ `session.data`.
- Relay `src/gateway/relay.ts` `createRelay` giữ dumb — forward frames, không `JSON.parse`, không `ALLOWED_METHODS` check — ends (daemon + client) enforce.

## 5. Relay infra hardening

- Dumb forwarder deploy (Worker style `api.deck.spacevibe.dev`) — ngoài repo, chỉ cần doc contract: workspace routing via `workspaceId` in `RelayOptions`, presence via `onClose/onError` closeBoth.
- Gateway `auth.ts` `READ_METHODS`/`CONTROL_METHODS` + `gateway.ts` `ALLOWED_METHODS` vẫn là allowlist tại ends — relay không duplicate.
- Audit `gateway.audit.log` append-only vẫn ghi tại gateway ends.

## 6. File map

- Modify: `.github/workflows/ci.yml` (job sandbox-linux), `src/gateway/relay.ts` (doc + routing comment), `src/isolation/sandbox.ts` (comment parity, no logic), `src/gateway/auth.ts`/`gateway.ts` (allowlist doc if needed), `src/daemon/methods.ts` (session.data E2E envelope — later task).
- New (later): `src/gateway/e2e.ts` (deriveKey + encrypt/decrypt, stdlib only), `tests/gateway/e2e.test.ts`.
- Docs: this file, `docs/superpowers/specs/2026-09-24-horizon-d-known-limitations.md` (khi đóng).

## 7. Gate

`bun run typecheck` · `bun test --concurrency 1` · `bun run build` + `ubuntu-latest` sandbox-linux job xanh. Tất cả tuần tự, concurrency 1 khi tải cao (AGENTS.md Resource budget). Không thêm native module.
