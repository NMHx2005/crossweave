# Horizon D — Sandbox + Gateway Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Khóa trust boundary trước khi Stage 3 hosted — sandbox parity CI + session.data E2E + relay dumb forwarder hardening.

**Architecture:** Không fork method table — thêm `src/gateway/e2e.ts` (HKDF + aes-256-gcm via node:crypto) bọc `session.data` tại ends; relay giữ dumb forward; sandbox thêm CI job ubuntu-latest chạy bwrap thật, không đổi provider logic.

**Tech Stack:** TypeScript / Bun / bun:sqlite / node:crypto (stdlib) / bubblewrap / GitHub Actions

**Spec:** `docs/superpowers/specs/2026-09-24-horizon-d-sandbox-gateway-hardening-design.md` + `docs/superpowers/plans/2026-09-21-long-roadmap-spacevibe-crossweave.md` Horizon D section + `docs/superpowers/specs/2026-09-18-os-sandbox-design.md`

## Global Constraints

- Bun >= 1.3.13, TypeScript, bun:sqlite, bun test, bun build --compile
- Zero native modules — node:crypto only (stdlib), reject .node
- macOS + Linux only
- main linear fast-forward, không commit trực tiếp khi chưa OK
- Resource budget RAM/CPU: gate tuần tự, concurrency 1 khi tải cao, không để watch/daemon orphan
- Gate: bun run typecheck · bun test · bun run build + sandbox-linux CI job xanh

---

### Task 1: Design (done) — 2026-09-24-horizon-d-sandbox-gateway-hardening-design.md

- [x] Spec đã tạo — không cần code.

### Task 2: CI — sandbox-linux job + relay doc hardening

**Files:**
- Modify: `.github/workflows/ci.yml` (thêm job `sandbox-linux`)
- Modify: `src/gateway/relay.ts` (routing/presence doc, không đổi forward logic)
- Modify: `src/isolation/sandbox.ts` (comment parity, không đổi buildBwrapArgs)
- Test: `tests/gateway/relay.test.ts` (nếu chưa có — giữ dumb assert)

**Interfaces:**
- Consumes: `createRelay(a,b,opts)` signature hiện có
- Produces: CI job `sandbox-linux` chạy `bwrap` thật, relay doc rõ ends enforce

- [ ] **Step 1: Thêm job sandbox-linux vào ci.yml** — ubuntu-latest, setup-bun 1.3.14, install bubblewrap ripgrep, bun install, typecheck, bun test tests/isolation/sandbox.test.ts
- [ ] **Step 2: Patch relay.ts — doc workspaceId routing + presence + ends enforce**
- [ ] **Step 3: Patch sandbox.ts — comment parity (no logic)**
- [ ] **Step 4: Gate tuần tự** — bun run typecheck → bun test --concurrency 1 (không cần bwrap local) → bun run build
- [ ] **Step 5: Commit** — git add .github/workflows/ci.yml src/gateway/relay.ts src/isolation/sandbox.ts; commit feat(ci): sandbox-linux job + relay hardening docs

### Task 3: E2E — session.data encrypt/decrypt envelope (stdlib only)

**Files:**
- Create: `src/gateway/e2e.ts`
- Create: `tests/gateway/e2e.test.ts`
- Modify: `src/daemon/methods.ts` (bọc session.data khi có key — behind helper, không đổi RPC name)
- Modify: `src/client/rpc-client.ts` hoặc `src/gateway/ws-transport.ts` (unwrap tại client — nếu cần)
- Test: `tests/gateway/e2e.test.ts` 4+ cases

**Interfaces:**
- Consumes: `gateway.token` (0600) + workspaceId → key
- Produces: `deriveKey(token, workspaceId)`, `encrypt(data, key)`, `decrypt(blob, key)` — AEAD, stdlib only

- [ ] **Step 1: Viết failing test e2e** — deriveKey + encrypt/decrypt round-trip + wrong key fails
- [ ] **Step 2: Implement e2e.ts — HKDF SHA-256 + aes-256-gcm, random 12B nonce, no native**
- [ ] **Step 3: Wire vào daemon methods (opt-in khi token tồn tại, fallback plaintext)**
- [ ] **Step 4: Gate** — bun run typecheck → bun test tests/gateway/e2e.test.ts --concurrency 1 → bun run build
- [ ] **Step 5: Commit** — git add src/gateway/e2e.ts tests/gateway/e2e.test.ts src/daemon/methods.ts; commit feat(gateway): session.data E2E envelope (HKDF + aes-gcm, stdlib only)

### Task 4: Docs — đóng Horizon D (deferred phần infra nếu chưa deploy)

**Files:**
- Modify: `docs/PROGRESS.md`
- Modify: `docs/superpowers/specs/2026-08-14-known-limitations-digest.md`
- Create: `docs/superpowers/specs/2026-09-24-horizon-d-known-limitations.md`

- [ ] **Step 1: Cập nhật PROGRESS (D: CI + E2E wired, relay infra deferred)**
- [ ] **Step 2: Cập nhật digest**
- [ ] **Step 3: Tạo known-limitations.md**
- [ ] **Step 4: Commit** — docs(progress): Horizon D sandbox+E2E wired, relay infra deferred
