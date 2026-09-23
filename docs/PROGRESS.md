# Progress — crossweave × SpaceVibe Deck Long Roadmap

**Last updated:** 2026-09-24 (main = 0d8759c)
**Roadmap:** `docs/superpowers/plans/2026-09-21-long-roadmap-spacevibe-crossweave.md`

## Done

| Date | Milestone | Commit | Gate |
|---|---|---|---|
| 2026-09-21 | Rail active polish (Cursor material) | `d79d401` | typecheck + tokens.test |
| 2026-09-21 | Linux bwrap provider | `c692c86` | sandbox.test 22 pass |
| 2026-09-21 | bwrap hardening (7 escape probes) | `4c225b4` | sandbox.test + spec table |
| 2026-09-21 | Sandbox surface (list + rail) | `0c1d60f` / `2a3ba2d` | typecheck + build |
| 2026-09-21 | Gateway Stage 0 (WS shuttling) | `4d43672` | gateway.test 3 pass |
| 2026-09-21 | Gateway Stage 1 (token auth) | `d26a577` | gateway-auth.test |
| 2026-09-21 | Gateway Stage 1b (read/control + audit) | `8fc3edc` | gateway-auth.test 4 pass |
| 2026-09-21 | Gateway Stage 1c (TLS gating) | `0952d07` | gateway-tls.test 3 pass |
| 2026-09-21 | Gateway Stage 2 (web pane) | `24ed07a` | gateway-web.test |
| 2026-09-21 | Gateway serve polish (static + WS upgrade) | `c09ea7b` / `d88ad1b` | build |
| 2026-09-21 | Gateway Stage 3 relay skeleton | `34aafde` | gateway-relay.test |
| 2026-09-21 | Cockpit tests fix (worktreePath compat) | `5675e7b` | cockpit-host/session-data pass |
| 2026-09-21 | Horizon A — Deck bridge — **skeleton, chưa wire** | `94d4115` | typecheck + deck-bridge.test 1 pass (in-memory) |
| 2026-09-21 | Horizon B — Journal + activity — **đã wire** | `6c53e9f` / `0856efb` + `798df0b` | journal-activity + methods-journal + cockpit-host/activity/tokens + live app (restore + unread row) |
| 2026-09-24 | Horizon C — Usage spec | `87ae992` | design `2026-09-24-horizon-c-usage-design.md` |
| 2026-09-24 | Horizon C — Usage aggregate + RPC | `bea4bc6` | usage-aggregate.test + methods-usage.test + typecheck + build |
| 2026-09-24 | Horizon C — Cockpit usage pane | `0d8759c` | cockpit channels/api/App + app.css tokens + cockpit build |

## Nợ kỹ thuật

**A vẫn là khung chưa wire** — chi tiết: `docs/superpowers/specs/2026-09-21-deck-bridge-known-limitations.md`.

Đóng A:
- Khởi tạo `DeckBridge` từ một entry point thật (extension/sidecar) — hiện không ai gọi.
- Map card model của Deck thật (heading/colour/dot/selected frame) + reuse worktree creation flow.
- Wire tín hiệu `waiting` đầu tiên để `needs_you` fire được (hiện `SessionRepo` ghi rõ UNREACHABLE).

**B đã wired** (daemon sở hữu journal qua `journal.get`/`journal.set`, cockpit restore
thứ tự pane + focus, rail có unread/View all/ack) — phần còn thiếu được ghi ở
`docs/superpowers/specs/2026-09-21-journal-activity-known-limitations.md`: scrollback
snapshot, `needs_you` chưa có producer, `fileSurfaces` luôn rỗng, TUI chưa tham gia.

Ghi chú cấu trúc: `deriveAttention` nằm ở `apps/cockpit/src/lib/attention.ts` (renderer),
không phải engine — A/C muốn dùng chung thì phải lift lên `src/`.

## In progress / Next

- **In progress:** Horizon C — Usage accounting (engine + cockpit done, telemetry deferred)
- **Next:** Horizon A — Deck bridge closure (lift deriveAttention + card mapping + waiting signal)
- Deferred: Stage 3 hosted relay E2E + infra, Windows packaging (until `cwd` on Windows)

## Horizon overview

- **A** Deck × crossweave bridge — skeleton (`94d4115`), chưa wire
- **B** Session journal + Recent activity — đã wire (journal RPC + restore + activity rail)
- **C** Usage accounting — engine + cockpit wired (telemetry opt-in deferred)
- **D** Sandbox + Gateway hardening for hosted
- **E** File explorer + browser tabs in gateway web
- **F** Distribution hợp nhất (install.sh chung)

## How to verify

```bash
bun run typecheck
bun run build        # dist/cw, dist/cwd
bun test             # outside sandbox for socket tests
```

All horizons follow subagent-driven-development; `main` stays linear (fast-forward merges).
