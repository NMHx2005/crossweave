# Progress — crossweave × SpaceVibe Deck Long Roadmap

**Last updated:** 2026-09-21 (main = 0856efb)
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
| 2026-09-21 | Horizon A — Deck bridge | `94d4115` | deck-bridge.test 1 pass |
| 2026-09-21 | **Horizon B — Journal + Recent activity** | `6c53e9f` / `0856efb` | journal-activity.test 2 pass |

## In progress / Next

- **Next:** Horizon C — Usage accounting hợp nhất (group by agent/day, telemetry opt-in)
- Deferred: Stage 3 hosted relay E2E + infra, Windows packaging (until `cwd` on Windows)

## Horizon overview

- **A** Deck × crossweave bridge — DONE (`94d4115`)
- **B** Session journal + Recent activity — DONE (`0856efb`)
- **C** Usage accounting — NEXT
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
