# Horizon C — Usage Accounting Hợp Nhất — Design

**Date:** 2026-09-24
**Horizon:** C of `docs/superpowers/plans/2026-09-21-long-roadmap-spacevibe-crossweave.md`
**Tier:** Medium — aggregation + read-only RPC + cockpit pane + telemetry opt-in, no DB migration, no native modules.
**Status:** design — precedes `docs/superpowers/plans/2026-09-24-horizon-c-usage-accounting.md`

## 1. Goal

Một dashboard usage hợp nhất: đọc cùng local session state của crossweave (và Deck logs nếu có), group token/cost theo agent và theo ngày, hiển thị trong cockpit + qua RPC read-only, không cần account. Telemetry first-party opt-in (default OFF), per-day buffer, POST khi consent — không gửi code/paths/prompts.

Tham chiếu: Deck Local usage accounting (group by agent/day, không cần account; từ 1.1.0 telemetry always-on) và crossweave M6a (`token_spent`/`cost_spent_usd` + `recordUsage` + `session.reportUsage`).

## 2. Non-goals

- Không per-turn granularity — cả hai nguồn (Claude Code statusLine và ACP `usage_update`) chỉ báo cumulative session-level totals (M6a §2).
- Không auto-pause khi quá budget — M6a đã để ngỏ cho M6c/TUI, giữ nguyên.
- Không authoritative billing — `costSpentUsd` là client-side estimate, phải ghi rõ trên UI (M6a known-limitation).
- Không account, không server-side aggregation — không đụng infra Stage 3.
- Không fork method table — chỉ thêm một RPC read-only qua allowlist hiện có.

## 3. Data model

### 3.1 Source of truth

- Engine source: `SessionRepo.listByWorkspace(workspaceId)` → `SessionRow { id, agentKind, tokenSpent, costSpentUsd, createdAt, status }`. Cumulative semantics như M6a: ghi thẳng `token_spent`/`cost_spent_usd`, không delta.
- Deck logs (nếu có): đọc local Deck session logs cùng format — adapter đọc là best-effort, thiếu thì chỉ trả crossweave rows. Không yêu cầu Deck repo checkout để gate pass.

### 3.2 Aggregation shapes

```ts
// src/domain/usage-aggregate.ts
export interface UsageSummary {
  date: string;          // YYYY-MM-DD (UTC, từ createdAt/lastActiveAt)
  agentKind: string;     // claude | cursor | cursor-print | opencode | unknown
  sessions: number;
  tokens: number;        // sum tokenSpent
  costUsd: number;       // sum costSpentUsd
}
export type GroupBy = 'day' | 'agent' | 'day+agent';
export function aggregateUsage(rows: SessionRow[], opts?: { groupBy?: GroupBy }): UsageSummary[];
```

- `groupBy = 'day+agent'` mặc định: một dòng cho mỗi (date, agentKind). `day` gộp agent, `agent` gộp ngày.
- `fileSurfaces`/`openTabs` không liên quan — chỉ sum spend.
- Empty workspace → `[]`, không lỗi.

### 3.3 Known semantic gap (carry from M6a)

ACP `usage_update.used` là context-window occupancy, có thể GIẢM sau compaction — `tokenSpent` cho T1 sessions vì thế không monotonic, khác với Claude Code path. `costSpentUsd` thì monotonic (cả hai nguồn). UI phải ghi chú "estimate" và không dùng `tokenSpent` để trigger billing.

## 4. RPC

- Name: `usage.summary`
- Params: `{ workspaceId: string, groupBy?: GroupBy }`
- Returns: `{ summaries: UsageSummary[] }`
- Read-only — chỉ đọc `SessionRepo`, không write, không đụng `config_trust` hay `journal`.
- Allowlist: thêm vào `ALLOWED_METHODS` (`src/gateway/gateway.ts`) và `READ_METHODS` (`src/gateway/auth.ts`) — read token được đọc, control mới được write (như `journal.get` vs `journal.set`).
- Không thêm RPC khác (telemetry không cần RPC mới — buffer là file local).

## 5. Cockpit surface

- Channel: `usage:summary` trong `apps/cockpit/electron/channels.ts` → `cockpit-api.ts` `loadUsage(workspaceId, groupBy?)`.
- UI: Usage pane/tab trong `App.tsx` — table group by agent/day, tổng tokens + cost với nhãn "estimate — not billing". Reuse `tokens.ts` — không literal colours, không orphan `var()`, WCAG AA (guard bởi `tokens.test.ts`).
- Không đụng `Stage` PTY — chỉ đọc.

## 6. Telemetry (opt-in)

- Default OFF. Toggle trong Settings → Privacy (như Deck spec).
- Khi ON: ghi `telemetry.json` per-day buffer dưới `.crossweave/` (atomic tmp+rename như `journal.ts`); POST `api.deck.spacevibe.dev/v1/ping` batch per-day — chỉ khi consent, không gửi code/paths/prompts.
- Khi OFF: không ghi, không POST. Không cần RPC — daemon không cần biết.
- Telemetry là best-effort, không block gate nếu endpoint không tồn tại trong test.

## 7. File map

- New: `src/domain/usage-aggregate.ts`, `tests/domain/usage-aggregate.test.ts`, `tests/daemon/methods-usage.test.ts`
- Modify: `src/daemon/methods.ts` (handler), `src/gateway/auth.ts`, `src/gateway/gateway.ts`, `apps/cockpit/electron/channels.ts`, `apps/cockpit/src/host/cockpit-api.ts`, `apps/cockpit/src/ui/App.tsx`, `apps/cockpit/src/ui/app.css`
- Docs: this file, `docs/superpowers/specs/2026-09-24-horizon-c-known-limitations.md` (khi đóng horizon)

## 8. Gate

`bun run typecheck` · `bun test --concurrency 1` · `bun run build` (repo) · `cd apps/cockpit && bun test --concurrency 1 && bun run build` + live app check khi đụng UI.
Tất cả chạy tuần tự, concurrency 1 khi tải cao (AGENTS.md Resource budget).
