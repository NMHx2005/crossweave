# Long Roadmap — crossweave × SpaceVibe Deck (2026-Q4 → 2027-Q4)

**Date:** 2026-09-21
**Status:** draft (plan only — implementation staged by horizon)
**Scope:** toàn bộ công cụ hiện tại (cw/cwd + Cockpit + gateway 0→3) kết hợp hướng SpaceVibe Deck: attention-first terminal, worktree/PTY, Agent Rail, session journal, usage accounting — để ra một hệ sinh thái "chạy N agent song song an toàn, nhìn thấy ai cần mình, land an toàn".
**Tier:** Very Large — ~12 tháng, nhiều horizon, mỗi horizon có spec + plan con riêng.

---

## 0. Điểm xuất phát (2026-09-21, main = 337a98d onward)

**crossweave đã có:**
- Core loop: workspace/session + worktree isolation + leases (port/docker/cache/db) + Collision Radar (claim indexer + decideBlocked) + Convergence Engine (trial merge + land order + land all) + Safe Mode T1/T2/T3 + budget/burn + notifications (macOS) + distribution/install.sh + TUI (`cw tui`, bare `cw`) — spec 2026-08-09 + M0-M8.
- Cockpit Electron macOS arm64: real xterm panes (full VT, không strip ANSI), attention rail (working/needs_you/blocked/ready/unknown), land từ UI, một token source `tokens.ts` cho cả chrome + pane — spec 2026-09-16/17.
- OS sandbox: macOS seatbelt + Linux bwrap (`buildBwrapArgs` + `planSandbox` branch), gated `which bwrap`, private TMPDIR, narrow git binds — spec 2026-09-18.
- Client seam (`src/client/transport.ts` + `DaemonClient.attach`) + gateway Stage 0 (WS shuttling, allowlist `ALLOWED_METHODS`, in-memory tests) → Stage 1 (per-workspace token `gateway.token` 0600, `cw gateway token|revoke`) → Stage 1b (read/control split `READ_METHODS` + `gateway.audit.log`) → Stage 1c (TLS gating `server.ts` + `cw gateway serve`) → Stage 2 (web pane `src/gateway/web/` xterm.js qua `wsTransport`) → Stage 3 relay skeleton (`src/gateway/relay.ts` dumb forwarder). Stage 3 E2E + infra vẫn deferred theo spec 2026-09-18-client-seam-and-remote.md.

**SpaceVibe Deck đã có (tham chiếu):**
- Attention-first Agent Rail: working/asked/failed + latest words cho Claude/Codex/OpenCode, jump-to-attention (Cmd+Shift+A), recent activity (unread), attention loop Launch→Watch→Jump→Resume — README 1480309472833505236†L7-L34.
- One project stage: real PTYs split panes, move between worktrees, browser pages as tabs, Cmd/Ctrl+click mở file, tab pin/close/reorder — cùng nguồn.
- Sessions that come back: journal open tabs/file surfaces, guard boot restoration, resume exact cho Claude/Codex/OpenCode — cùng nguồn.
- Local usage accounting: đọc local session logs, group token/cost by agent/day, không cần account; từ 1.1.0 first-party telemetry always-on — cùng nguồn.
- Trust & distribution: `curl deck.spacevibe.dev/install.sh`, signed macOS arm64, unsigned Windows x64, updater qua `latest` — cùng nguồn.

**Ý tưởng kết hợp (guiding principle):**
- **Deck là Cockpit của crossweave:** Deck's Stage + Agent Rail + attention loop là UI; crossweave's `cwd` + Radar + Convergence + sandbox là engine đảm bảo "N agent không dẫm chân nhau và land được". Không fork engine, không fork UI — nối qua `ClientTransport` seam đã có.
- **Một repo, N worktree, N pane, một truth:** mọi client (TUI, Cockpit, Deck-tab, web pane, phone) đều là thin `DaemonClient` qua gateway — không ai spawn agent trực tiếp.
- **An toàn trước, xa sau:** sandbox + auth + TLS + audit phải chắc trên cả macOS/Linux trước khi mở hosted relay.

---

## Horizon A — Deck × crossweave: một app, một engine (2026-Q4, 6–8 tuần)

**Goal:** mở Deck, thấy crossweave sessions như Deck worktree cards, land từ Deck, không cần chuyển app.

**Spec con:** `2026-10-XX-deck-crossweave-bridge-design.md` (mới)

**Tasks:**
1. **Bridge process:** `src/deck/bridge.ts` — Deck extension / sidecar nói `DaemonClient` qua unix socket (local) hoặc `wsTransport` qua gateway (remote). Expose `session.list` + `converge.status` + `land.session` + `tui.event` như Deck's rail model.
2. **Worktree card mapping:** crossweave `worktreePath`/`branch` ↔ Deck `worktree card` (heading, color picker, dot, selected frame). Reuse Deck's worktree creation flow (up-to-1-min checkout, partial-checkout guard) — deck đã có spec `worktree creation`.
3. **Attention mapping:** crossweave `deriveAttention` (working/needs_you/blocked/ready/unknown/conflict) → Deck's rail marks (working/asked/failed) + latest words (từ `session.data` tail). `needs_you` (waiting) cần wire thật lần đầu (hiện unreachable trong `SessionRepo`).
4. **Land từ Deck:** nút "Land" trên worktree card / command palette — gọi `land.session` với evidence gate, show `blocked` reason như Cockpit đã làm. Reuse `landAllInOrder` + re-fetch sau mỗi land.
5. **File open:** Cmd+click trên Deck pane mở đúng file trong worktree của session đó (không phải main checkout) — crossweave worktree paths đã có.

**Gate:** `bun run typecheck` · `bun run build` · `bun test` + Deck dev (`npm run electron:dev`) với 2 crossweave sessions thật, land một, thấy badge đổi.

## Horizon B — Session journal + Recent activity cho crossweave (2026-Q4 → 2027-Q1)

**Goal:** như Deck "Sessions that come back" + Recent activity (5 latest unread: questions/warnings/completed) áp cho crossweave sessions.

**Tasks:**
1. **Journal:** daemon journal `openTabs + fileSurfaces + sessionIds` (như Deck `session journal`), guard crash-loop, restore sau boot không assign cùng session hai lần — deck đã doc `session journal`.
2. **Recent activity feed:** `tui.event` kinds `blocked`/`needs_you`/`landed` → unread set, `View all` history, ack khi select pane — như Deck `Recent activity`.
3. **Scrollback persistence:** pane scrollback + unsaved edits hiện Deck không restore — crossweave pane (xterm) giữ scrollback trong `XtermPane` như đã fix (836a76f), journal thêm scrollback snapshot cho restore.

## Horizon C — Usage accounting hợp nhất (2027-Q1)

**Goal:** một dashboard usage cho cả Deck agents lẫn crossweave sessions — đọc cùng local session logs, group by agent/day như Deck `usage aggregation`, không cần account.

**Tasks:**
1. Hợp nhất `costSpentUsd`/`tokenSpent` (crossweave M6a) với Deck's usage reader (đọc Claude/Codex/OpenCode local logs).
2. First-party telemetry (Deck 1.1.0 always-on, không code/paths/prompts) — áp cho crossweave: `telemetry.json` per-day buffers, POST `api.deck.spacevibe.dev/v1/ping` — chỉ khi user consent, doc rõ trong Settings → Privacy như Deck.

## Horizon D — Sandbox + Gateway hardening để dám ship hosted (2027-Q1 → Q2)

**Goal:** khóa trust boundary trước khi Stage 3 thật.

**Tasks:**
1. **Sandbox parity:** bwrap escape table đã harden (Horizon A đã có), thêm CI job `ubuntu-latest` chạy `bwrap integration (real bwrap)` thật (hiện skip trên macOS) — như đã làm cho seatbelt.
2. **Gateway Stage 3 E2E:** per-session symmetric key derived từ workspace token, `session.data` E2E giữa daemon và client, relay chỉ forward bytes (đã có `relay.ts` skeleton) — spec Stage 3 E2E design.
3. **Relay infra:** dumb forwarder deploy (Cloudflare Worker `api.deck.spacevibe.dev` style — deck đã dùng Worker) + workspace routing + presence. Không enforce `ALLOWED_METHODS` ở relay — ends enforce.

## Horizon E — File explorer + browser tabs trong gateway web (2027-Q2)

**Goal:** web pane không chỉ là terminal — như Deck's One project stage: file explorer panel, tree, one file-open path + browser pages as tabs.

**Tasks:**
1. Gateway `webRoot` serve file tree RPC (`workspace.listFiles` — đã có Radar indexer) + `openFile` → Monaco (như Deck dùng Monaco Editor).
2. Browser tabs as tabs on the same stage — `stage strip` với tab pin/close/rearrange như Deck `tab strip`.

## Horizon F — Distribution hợp nhất (2027-Q3 → Q4)

**Goal:** một installer cho cả Deck + crossweave engine — như Deck `curl deck.spacevibe.dev/install.sh` và crossweave `curl raw.../install.sh`, gộp thành `curl spacevibe.dev/install.sh` cài cả `cwd` + Deck + gateway.

**Tasks:**
1. `install.sh` chung: detect darwin-arm64/linux-x64, cài `cw`/`cwd` + Deck `.app` (signed macOS) + `bwrap` check trên Linux, checksum-gated như crossweave đã làm.
2. Windows: khi `cwd` POSIX→Windows (Bun pty + unix sockets), Deck Windows x64 đã unsigned — cần signed + runtime verification như Deck 1.0 TODO.
3. Updater chung: Deck's `latest` moving release + crossweave `cw update` — một check, một relaunch.

---

## Cách làm việc

- Mỗi horizon là **một spec + một plan** riêng (như các plan `2026-09-XX-*` hiện có), implement bằng **subagent-driven-development**: fresh subagent per task, task review (spec compliance + code quality), broad final review.
- `main` stays linear (fast-forward merges), không commit trực tiếp khi chưa có OK — như AGENTS.md §6.
- Gate chung: `bun run typecheck` · `bun test` (outside sandbox cho socket) · `bun run build` + Cockpit/Deck running-app check cho UI changes.

## Definition of done cho cả roadmap

`Ready` không còn là "landable" mà là "đã land thử và xanh" — như crossweave Convergence đã làm — áp cho cả Deck sessions. Một session `idle`/`dead` luôn `unknown`/`stopped` (1ca90c9), không bao giờ green. Gateway mọi method đều qua `ALLOWED_METHODS` allowlist + `READ_METHODS` split, audit log append-only. Sandbox mọi write ngoài worktree đều bị chặn trên cả macOS (seatbelt) và Linux (bwrap), đo bằng integration suite thật trên CI.
