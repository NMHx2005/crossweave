# Progress — crossweave × SpaceVibe Deck Long Roadmap

**Last updated:** 2026-09-24 (main = eff82d9)
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
| 2026-09-21 | Horizon A — Deck bridge — skeleton | `94d4115` | typecheck + 1 test |
| 2026-09-24 | Horizon A — Deck bridge — **wired** (attention lift + card + waiting) | `d99893d` | deck-bridge 5 + attention 8 + session.wait 2 + typecheck + build |
| 2026-09-21 | Horizon B — Journal + activity — **đã wire** | `6c53e9f` / `0856efb` + `798df0b` | journal-activity + methods-journal + cockpit-host/activity/tokens + live app (restore + unread row) |
| 2026-09-24 | Horizon C — Usage spec | `87ae992` | design `2026-09-24-horizon-c-usage-design.md` |
| 2026-09-24 | Horizon C — Usage aggregate + RPC | `bea4bc6` | usage-aggregate.test + methods-usage.test + typecheck + build |
| 2026-09-24 | Horizon C — Cockpit usage pane | `0d8759c` | cockpit channels/api/App + app.css tokens + cockpit build |
| 2026-09-24 | Horizon D — Design + plan | `ab8ed61` | spec + plan `2026-09-24-horizon-d-*` |
| 2026-09-24 | Horizon D — Relay + sandbox parity | `5322f7c` | relay docs + sandbox.ts parity note + CI sandbox-linux job (pending sudo) |
| 2026-09-24 | Horizon D — E2E helpers | `accafc2` | e2e.ts + e2e.test 4 pass + typecheck + build |
| 2026-09-24 | Horizon E/F — file explorer + distribution | `92bbafd` | workspace.openFile 2 pass + web client + install.sh bwrap check + runtime hook |
| 2026-09-24 | C/D hardening sprint — telemetry + E2E wire | `eff82d9` | telemetry 1 pass + e2e wire decrypt + typecheck + build |

## Nợ kỹ thuật

**A đã wire phía crossweave** (`d99893d`) — chi tiết: `docs/superpowers/specs/2026-09-21-deck-bridge-known-limitations.md` — còn lại: Deck extension/sidecar register, worktree creation reuse, land button/palette, session.data tail wiring.

**B đã wired** (daemon sở hữu journal qua `journal.get`/`journal.set`, cockpit restore
thứ tự pane + focus, rail có unread/View all/ack) — phần còn thiếu được ghi ở
`docs/superpowers/specs/2026-09-21-journal-activity-known-limitations.md`: scrollback
snapshot, `needs_you` chưa có producer, `fileSurfaces` luôn rỗng, TUI chưa tham gia.

Ghi chú cấu trúc: `deriveAttention` đã lift lên `src/domain/attention.ts` (d99893d) — A/C dùng chung engine version.

## In progress / Next

- **Done:** Horizon C — Usage accounting wired (telemetry opt-in deferred, spec-only)
- **Done:** Horizon A — Deck bridge wired crossweave-side (attention lift + card + waiting); Deck UI deferred
- **Done:** Horizon D — Sandbox + Gateway hardening (CI + E2E helpers wired, relay infra deferred)
- **Done:** Horizon E — File explorer READ (openFile + web client)
- **Done:** Horizon F — Distribution (install.sh unified + bwrap check)
- **Done:** C/D hardening sprint — telemetry opt-in (default OFF) + session.data E2E wire (ends-only envelope)
- **Next:** Horizon E remaining — browser tabs as tabs on stage strip (Monaco deferred)
- Deferred: Stage 3 hosted relay E2E + infra, Windows packaging (until `cwd` on Windows)

## Horizon overview

- **A** Deck × crossweave bridge — wired crossweave-side (`d99893d`), Deck UI deferred
- **B** Session journal + Recent activity — đã wire (journal RPC + restore + activity rail)
- **C** Usage accounting — engine + cockpit wired (telemetry opt-in deferred)
- **D** Sandbox + Gateway hardening — wired (relay infra deferred)
- **E** File explorer — workspace.openFile READ + web client wired
- **F** Distribution — install.sh unified
- **E** File explorer + browser tabs in gateway web
- **F** Distribution hợp nhất (install.sh chung)

## How to verify

```bash
bun run typecheck
bun run build        # dist/cw, dist/cwd
bun test             # outside sandbox for socket tests
```

All horizons follow subagent-driven-development; `main` stays linear (fast-forward merges).
