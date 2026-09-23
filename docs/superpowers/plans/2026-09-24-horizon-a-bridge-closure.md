# Horizon A — Deck Bridge Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Đóng 5 gaps của Horizon A skeleton để mở Deck thấy crossweave sessions như Deck worktree cards thật — có call site, card mapping, attention, land, file open.

**Architecture:** Không đụng Deck repo — bridge là sidecar/extension process trong crossweave (src/deck/bridge.ts) nói DaemonClient qua unix socket / wsTransport; lift deriveAttention từ renderer lên src/domain để engine + bridge + cockpit cùng dùng; card mapping reuse worktree creation flow hiện có.

**Tech Stack:** TypeScript / Bun / DaemonClient / ClientTransport (unixSocketTransport, wsTransport) / Electron cockpit tokens

**Spec:** `docs/superpowers/specs/2026-10-01-deck-crossweave-bridge-design.md` + `docs/superpowers/specs/2026-09-21-deck-bridge-known-limitations.md` + `docs/superpowers/plans/2026-09-21-long-roadmap-spacevibe-crossweave.md` Horizon A §

## Global Constraints

- Bun >= 1.3.13, TypeScript, bun:sqlite, bun test, bun build --compile
- Zero native modules
- macOS + Linux only
- main linear fast-forward, không commit trực tiếp khi chưa OK
- Resource budget RAM/CPU: gate tuần tự, concurrency 1 khi tải cao, không để watch/daemon orphan
- Gate: bun run typecheck · bun test · bun run build + Deck dev với 2 live sessions thật

---

### Task 1: Lift deriveAttention lên engine

**Files:**
- Create: `src/domain/attention.ts` (move từ apps/cockpit/src/lib/attention.ts)
- Modify: `apps/cockpit/src/lib/attention.ts` (re-export từ src/domain/attention.ts)
- Modify: `src/deck/bridge.ts:1-20` (import từ domain)
- Test: `tests/domain/attention.test.ts` (move/extend từ apps/cockpit/tests)

**Interfaces:**
- Consumes: SessionRow + convergence status
- Produces: `deriveAttention(session, convergence) -> AttentionKind` dùng chung cho bridge + cockpit

- [ ] **Step 1: Viết failing test ở src/domain — cùng case với cockpit hiện tại**
- [ ] **Step 2: Move logic, re-export ở cockpit, bridge import engine version**
- [ ] **Step 3: Gate tuần tự — `bun run typecheck && bun test --concurrency 1 && bun run build`**
- [ ] **Step 4: Commit**
```bash
git add src/domain/attention.ts apps/cockpit/src/lib/attention.ts src/deck/bridge.ts tests/domain/attention.test.ts
git commit -m "refactor(attention): lift deriveAttention to domain for bridge reuse"
```

### Task 2: Bridge call site + worktree card mapping

**Files:**
- Create: `src/deck/index.ts` (entry point sidecar — khởi tạo DeckBridge từ socket/wsUrl)
- Modify: `src/deck/bridge.ts` (card shape: heading/colour/dot/selected frame, map từ session.name/branch/worktreePath)
- Test: `tests/client/deck-bridge.test.ts` (mở rộng: heading, colour, selected)

**Interfaces:**
- Consumes: `DaemonClient.call('session.list')`
- Produces: `WorktreeCard { id, heading, branch, worktreePath, colour, dot, selected }`

- [ ] **Step 1: Failing test cho card mapping — heading là session.name, colour/dot từ status**
- [ ] **Step 2: Implement card mapping + entry point**
- [ ] **Step 3: Gate + commit**
```bash
git add src/deck/index.ts src/deck/bridge.ts tests/client/deck-bridge.test.ts
git commit -m "feat(deck): bridge entry point + worktree card mapping"
```

### Task 3: Attention mapping + waiting signal đầu tiên + land + file open

**Files:**
- Modify: `src/db/repositories/session.ts:1-30` (cho phép write waiting — lần đầu)
- Modify: `src/daemon/methods.ts` (wire waiting signal — ví dụ từ pty idle prompt)
- Modify: `src/deck/bridge.ts` (attentionBySession + latest words từ session.data tail)
- Modify: `src/deck/bridge.ts` (land + re-fetch, file open resolve worktreePath)
- Test: `tests/domain/attention.test.ts` + `tests/client/deck-bridge.test.ts`

**Interfaces:**
- Consumes: deriveAttention đã lift, session.data
- Produces: rail marks working/asked/failed, land từ Deck, Cmd+click mở đúng worktree

- [ ] **Step 1: Failing test cho needs_you khi waiting thật**
- [ ] **Step 2: Implement waiting writer + bridge attention mapping + land + file open**
- [ ] **Step 3: Gate Deck dev với 2 live sessions — land một, badge đổi**
- [ ] **Step 4: Commit**
```bash
git add src/db/repositories/session.ts src/daemon/methods.ts src/deck/bridge.ts tests/domain/attention.test.ts tests/client/deck-bridge.test.ts
git commit -m "feat(deck): attention mapping + waiting + land + file open"
```

### Task 4: Docs — đóng known-limitations A

**Files:**
- Modify: `docs/superpowers/specs/2026-09-21-deck-bridge-known-limitations.md`
- Modify: `docs/superpowers/specs/2026-08-14-known-limitations-digest.md`
- Modify: `docs/PROGRESS.md` (A: wired)

- [ ] **Step 1: Cập nhật known-limitations + PROGRESS**
- [ ] **Step 2: Commit docs**
```bash
git add docs/superpowers/specs/2026-09-21-deck-bridge-known-limitations.md docs/superpowers/specs/2026-08-14-known-limitations-digest.md docs/PROGRESS.md
git commit -m "docs(progress): Horizon A bridge wired"
```
