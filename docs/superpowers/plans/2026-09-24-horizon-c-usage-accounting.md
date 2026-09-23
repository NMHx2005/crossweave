# Horizon C — Usage Accounting Hợp Nhất Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Một dashboard usage hợp nhất đọc cùng local session logs của crossweave + Deck, group token/cost theo agent/ngày, telemetry opt-in — không cần account.

**Architecture:** Mở rộng pipeline usage hiện có (statusLine + ACP usage_update → recordUsage → SessionRepo.updateUsage → token_spent/cost_spent_usd) thành usage feed có aggregation theo ngày/agent; thêm reader cho Deck's local logs nếu có, expose qua RPC read-only + cockpit UI. Telemetry là per-day buffer + POST opt-in, tắt mặc định.

**Tech Stack:** TypeScript / Bun / bun:sqlite / DaemonClient RPC / Electron cockpit (xterm + tokens.ts)

**Spec:** `docs/superpowers/plans/2026-09-21-long-roadmap-spacevibe-crossweave.md` Horizon C + `docs/superpowers/specs/2026-08-13-m6a-budget-burn-design.md` + `docs/superpowers/specs/2026-08-13-m6a-known-limitations.md`

## Global Constraints

- Bun >= 1.3.13, TypeScript, bun:sqlite, bun test, bun build --compile — một seam duy nhất tới Bun là adapter pty + sqlite + node:net socket
- Zero native modules — reject mọi dependency có .node binary
- macOS + Linux only — không half-support Windows
- Mỗi horizon là một spec + một plan riêng, main linear fast-forward, không commit trực tiếp khi chưa OK (AGENTS.md §6)
- Resource budget RAM/CPU: chạy gate tuần tự, concurrency 1 khi tải cao, không để watch/daemon orphan, build có chọn lọc, đo trước/sau gate nặng
- Gate chung: bun run typecheck · bun test (outside sandbox cho socket) · bun run build + cockpit running-app check cho UI
- Một line trong known-limitations digest cho mọi gap phát hiện

---

### Task 1: Spec Horizon C — usage + telemetry contract

**Files:**
- Create: `docs/superpowers/specs/2026-09-24-horizon-c-usage-design.md`
- Modify: `docs/superpowers/specs/2026-08-14-known-limitations-digest.md:1-10` (thêm entry Horizon C)

**Interfaces:**
- Consumes: long roadmap Horizon C §, M6a design §3, Deck usage aggregation tham chiếu
- Produces: contract cho Task 2/3 — shape `UsageDay { date, agentKind, tokens, costUsd, sessions }`, RPC name `usage.summary`, telemetry doc

- [ ] **Step 1: Viết spec Horizon C**
  - Định nghĩa aggregation: theo ngày + agentKind (claude/cursor/cursor-print/openCode), source = SessionRepo rows + (nếu có) Deck local logs — cùng cumulative semantics như M6a, ghi rõ cost là estimate không phải billing
  - Định nghĩa telemetry: telemetry.json per-day buffer dưới `.crossweave/`, POST `api.deck.spacevibe.dev/v1/ping` chỉ khi consent, không gửi code/paths/prompts — như Deck 1.1.0, doc trong Settings → Privacy
  - Ghi known gaps: ACP token là context occupancy có thể giảm sau compaction (M6a), không per-turn granularity, không auto-pause
- [ ] **Step 2: Review spec khớp Global Constraints**
  - Check không thêm native module, không fork daemon method table ngoài allowlist
- [ ] **Step 3: Commit spec**
```bash
git add docs/superpowers/specs/2026-09-24-horizon-c-usage-design.md docs/superpowers/specs/2026-08-14-known-limitations-digest.md
git commit -m "docs(spec): Horizon C usage accounting design"
```

### Task 2: Engine — aggregation + RPC read-only

**Files:**
- Create: `src/domain/usage-aggregate.ts`
- Modify: `src/daemon/methods.ts:800-900` (thêm handler `usage.summary` read-only)
- Modify: `src/gateway/auth.ts:1-40` (thêm `usage.summary` vào READ_METHODS)
- Modify: `src/gateway/gateway.ts:1-30` (thêm vào ALLOWED_METHODS)
- Test: `tests/domain/usage-aggregate.test.ts`
- Test: `tests/daemon/methods-usage.test.ts`

**Interfaces:**
- Consumes: `SessionRepo.listByWorkspace`, `SessionRow { agentKind, tokenSpent, costSpentUsd, createdAt }`
- Produces: `aggregateUsage(rows, { groupBy: 'day'|'agent' }) -> UsageSummary[]` và RPC `usage.summary` cho Task 3

- [ ] **Step 1: Viết failing test cho aggregate**
```ts
// tests/domain/usage-aggregate.test.ts
import { aggregateUsage } from '../../src/domain/usage-aggregate.js';
test('groups by day and agent', () => {
  const rows = [{ agentKind: 'claude', tokenSpent: 1000, costSpentUsd: 0.01, createdAt: '2026-09-24T00:00:00Z' }];
  const out = aggregateUsage(rows as any);
  expect(out[0].agentKind).toBe('claude');
});
```
- [ ] **Step 2: Chạy test — expect FAIL**
  Run: `bun test tests/domain/usage-aggregate.test.ts --concurrency 1`
- [ ] **Step 3: Implement aggregateUsage — group by date (YYYY-MM-DD) + agentKind, sum tokens/cost, không đụng DB**
- [ ] **Step 4: Thêm RPC `usage.summary` read-only — chỉ đọc SessionRepo, không write, trả UsageSummary**
- [ ] **Step 5: Allowlist gateway — READ_METHODS + ALLOWED_METHODS**
- [ ] **Step 6: Chạy gate tuần tự**
  Run: `bun run typecheck` → `bun test --concurrency 1` → `bun run build`
- [ ] **Step 7: Commit**
```bash
git add src/domain/usage-aggregate.ts src/daemon/methods.ts src/gateway/auth.ts src/gateway/gateway.ts tests/domain/usage-aggregate.test.ts tests/daemon/methods-usage.test.ts
git commit -m "feat(usage): aggregate by day/agent + usage.summary RPC"
```

### Task 3: Cockpit — usage pane + telemetry opt-in

**Files:**
- Modify: `apps/cockpit/electron/channels.ts:1-40` (thêm channel usage.summary)
- Modify: `apps/cockpit/src/host/cockpit-api.ts:1-40` (thêm loadUsage)
- Modify: `apps/cockpit/src/ui/App.tsx` (thêm Usage pane/tab)
- Modify: `apps/cockpit/src/ui/app.css` (token reuse, no literal colours)
- Test: `apps/cockpit/tests/cockpit-host.test.ts` (thêm case usage)
- Test: `apps/cockpit/tests/tokens.test.ts` (vẫn enforce WCAG AA)

**Interfaces:**
- Consumes: RPC `usage.summary` từ Task 2
- Produces: UI group by agent/day, telemetry toggle trong Settings → Privacy

- [ ] **Step 1: Viết failing test cho cockpit-host loadUsage**
- [ ] **Step 2: Implement channel + host + UI — table group by agent/day, cost là estimate label**
- [ ] **Step 3: Telemetry toggle — default OFF, khi ON mới buffer + POST, per-day file**
- [ ] **Step 4: Gate cockpit**
  Run: `cd apps/cockpit && bun run typecheck && bun test --concurrency 1 && bun run build` + live check computed styles / screenshot
- [ ] **Step 5: Commit**
```bash
git add apps/cockpit/electron/channels.ts apps/cockpit/src/host/cockpit-api.ts apps/cockpit/src/ui/App.tsx apps/cockpit/src/ui/app.css apps/cockpit/tests/cockpit-host.test.ts
git commit -m "feat(cockpit): usage accounting pane + telemetry opt-in"
```

### Task 4: Đóng dirty Horizon B + known-limitations

**Files:**
- Modify: `docs/PROGRESS.md` (đánh dấu Horizon B wiring đã commit, ghi C in-progress)
- Modify: `docs/superpowers/specs/2026-08-14-known-limitations-digest.md` (ghi gap telemetry + aggregation)
- Create: `docs/superpowers/specs/2026-09-24-horizon-c-known-limitations.md`

**Interfaces:**
- Consumes: trạng thái dirty hiện tại (18 files changed) — phải commit trước khi sang C
- Produces: PROGRESS + digest cập nhật

- [ ] **Step 1: Commit gọn dirty Horizon B hiện tại trước (journal/activity wiring)**
  Run: `bun run typecheck && bun test --concurrency 1 && bun run build` tuần tự, rồi `git add` đúng 18 files dirty + commit `feat(journal): ...`
- [ ] **Step 2: Cập nhật PROGRESS + digest + known-limitations cho C**
- [ ] **Step 3: Commit docs**
```bash
git add docs/PROGRESS.md docs/superpowers/specs/2026-08-14-known-limitations-digest.md docs/superpowers/specs/2026-09-24-horizon-c-known-limitations.md
git commit -m "docs(progress): Horizon B wired, Horizon C usage in progress"
```
