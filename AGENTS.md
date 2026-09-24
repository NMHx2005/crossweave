# crossweave — project rules

> The global rules (`~/.codex/AGENTS.md`) still apply. This file adds only what is
> specific to this repository: the map, the commands, the traps, and the decisions
> already made so they don't get relitigated.

## What this is

`cw` (CLI) and `cwd` (daemon) make N parallel agents on one repository safe and
mergeable. The daemon is the **sole owner** of `.crossweave/state.db` and of the
unix socket its clients speak JSON-RPC over; the CLI, the TUI and the Electron
cockpit are thin clients. **No client spawns agents, and nothing writes the
database except the daemon.**

Runtime constraints that shape every decision:

- Bun ≥ 1.3.13, TypeScript, `bun:sqlite`, `bun test`, `bun build --compile`.
- **Zero native modules, deliberately.** A dependency shipping a `.node` binary is
  grounds for rejecting a change — it means a postinstall could run on a user's
  machine. Ask before adding one.
- macOS and Linux only. Bun's pty and unix-domain sockets make Windows a non-target;
  do not half-support it.

## Commands

| What | Command |
|---|---|
| Tests (repo root) | `bun test` |
| Typecheck | `bun run typecheck` (`tsc --noEmit`) |
| Build binaries | `bun run build` → `dist/cw`, `dist/cwd` |
| Cockpit dev | `cd apps/cockpit && bun install && bun run dev` |
| Cockpit tests | `cd apps/cockpit && bun test` |
| Cockpit package (macOS arm64) | `cd apps/cockpit && bun run dist:mac` → `release/*.dmg` + `.zip` |
| Cockpit packaged smoke | `cd apps/cockpit && bun run package:smoke` |

**Trap — electron's binary.** `bun install` does not run electron's postinstall, so
`apps/cockpit/node_modules/electron/dist` stays empty and `bun run dev` /
`package:smoke` fail. Run `bun node_modules/electron/install.js` once inside
`apps/cockpit`.

**Trap — two real-binary verifications need to run outside any sandbox.** The cursor
and claude adapters are verified against the real CLIs, which need network, `~/.cursor`
and `~/.claude`. Spike scripts belong in `/tmp` and are throwaway; the conclusions get
recorded in the adapter's own comment (see `src/adapters/cursor-print.ts`).

**Trap — some tests cannot pass in a restricted shell.** Anything binding a unix
socket or probing host ports (`tests/client/*`, `tests/isolation/*`,
`apps/cockpit/tests/daemon-bridge-socket.test.ts`) fails with `EPERM` /
`NO_PORTS_AVAILABLE` when binds are forbidden. That is environmental: check the same
test against `main` before blaming a change, and say so in the report.

**Trap — `rm -rf` is blocked by a hook in this environment.** Move to `~/.Trash`
instead of fighting it.

## Map

| Path | What lives there |
|---|---|
| `src/core` | config (validated hard — `ports.named` may not shadow `PATH`/`PORT`), path containment (`assertContained`, symlink-by-symlink), framing, ids, errors |
| `src/db` | schema + forward-only migrations (applied inside `BEGIN IMMEDIATE`), repositories |
| `src/domain` | workspace, session lifecycle, event ledger, message bus, context store, gc, reconciliation |
| `src/isolation` | worktrees, leases (port/db/docker/cache), disk guard |
| `src/radar` | Collision Radar: claim indexer, contracts, noise gate, `decideBlocked` (the one blocking policy) |
| `src/convergence` | trial merges, conflict graph, `classifyLandability`, `land.ts` |
| `src/daemon` | RPC method table, session runtime (pty), worktree watchers, scheduler |
| `src/adapters` | `claude` (T2), `cursor` (T1/ACP), `cursor-print` (T3) |
| `src/mcp` | per-session MCP server (8 tools) |
| `apps/cockpit` | Electron thin client (macOS arm64 v1) |

## House conventions that are load-bearing

- **Comments explain WHY**, especially a race that was closed or an alternative that
  was rejected. This is the house style; keep it when you edit nearby code.
- Errors are `CrossweaveError` with a string code; user-facing copy in English; the
  CLI prints exactly one parseable `CODE: message` line.
- Every milestone ends with a `docs/superpowers/specs/<date>-*-known-limitations.md`
  plus a line in `docs/superpowers/specs/2026-08-14-known-limitations-digest.md`. If
  you find a gap, it belongs there — not only in your summary.
- Design first, then a plan file under `docs/superpowers/plans/`. Plans are records,
  not trackers: tick steps only while the plan is the live work item.
- Tests pin behaviour and contracts, never log strings or private internals. Never
  weaken a test to make it pass — say why it is wrong, then fix it.
- `main` stays linear (fast-forward merges) and nobody commits to it without an
  explicit OK.

## Decisions already made (do not relitigate)

- **Safe Mode never overstates.** T1 (ACP) and T2 (the Claude hook) block before a
  write; T3 is advisory and must always be *displayed* as advisory. Do not present a
  weaker tier as enforced to make a demo look better.
- **Leases are cooperative, not a sandbox.** They inject per-session port/docker/cache/
  db values; a process that ignores them still collides.
- **Toolchain stays reversible**: only three seams touch Bun — the adapter pty, the
  sqlite repositories, and `node:net` for the socket.
- **Cockpit borrows Cursor's *material*, not its anatomy.** One token source
  (`apps/cockpit/src/ui/tokens.ts`) feeds both the CSS chrome and the xterm pane;
  `apps/cockpit/tests/tokens.test.ts` enforces no literal colours, no orphan `var()`,
  and WCAG AA on every text/background pair. Rationale:
  `docs/superpowers/specs/2026-09-17-cockpit-design-system.md`.
- **The CLI TUI stays cross-platform** (`cw tui`); the cockpit is macOS-only until
  `cwd` itself runs elsewhere.


## Resource budget — RAM & CPU (local dev)

Máy dev là tài nguyên chung — mọi lệnh test/build phải giữ mức tiêu thụ thấp. Quy tắc bắt buộc khi chạy bất kỳ check nào:

- **Chạy tuần tự, không song song vô tội vạ.** Không chạy `bun test` + `typecheck` + `build` + `apps/cockpit` build cùng lúc. Mỗi lượt chỉ một gate nặng; xong mới chạy gate tiếp theo.
- **Giới hạn concurrency của test.** Ưu tiên `bun test --concurrency 1` (hoặc `GATE_BUDGET` thấp) khi máy đang tải; chỉ tăng concurrency khi đã đo và thấy còn dư RAM/CPU. Không spawn subagent/daemon/pty hàng loạt trong test — dùng in-memory/fake double nếu có thể.
- **Tránh watch/build lặp vô hạn.** Không để `tsc --watch`, `bun --watch`, `vite dev`, `electron dev` chạy nền sau khi xong việc. Kill process watch ngay khi không cần.
- **Dọn sau mỗi lần chạy.** Đóng daemon/socket/tmp worktree mà test đã tạo (`afterEach`/`afterAll` phải cleanup). Không để `cwd` hay `cw` orphan chiếm RAM.
- **Build có chọn lọc.** `bun run build` chỉ khi đụng `src/`; `apps/cockpit` build chỉ khi đụng `apps/cockpit/`. Không build toàn repo "cho chắc".
- **Khi nghi ngờ, đo trước.** Chạy `ps aux | head` / `top -l 1` / `memory_pressure` (macOS) hoặc `free -m` (Linux) trước và sau gate nặng; nếu RAM > 80% hoặc CPU pinned > 30s, dừng lại, giảm concurrency và báo trong report.
- **Report phải ghi chú.** Mỗi summary sau task ghi 1 dòng về gate đã chạy và mức concurrency đã dùng (vd: `bun test --concurrency 1 — pass`).

Vi phạm = phải dừng và giảm tải, không đổ lỗi cho môi trường.


## Reply style — thorough like Claude CLI (project override)

Khi trả lời trong repo này, hãy tận tình như Claude CLI — không chỉ "Done. X files changed":

- Giải thích **vì sao** làm vậy (quyết định, trade-off), **đụng file nào**, **gate nào đã chạy** (typecheck/test/build + kết quả), và **còn nợ gì** (known-limitations).
- Liệt kê 2-3 phương án khi có lựa chọn thiết kế, nêu khuyến nghị rồi mới làm.
- Báo tiến độ theo giai đoạn, không chỉ 1 dòng cuối. Vẫn giữ gate tuần tự + concurrency tiết kiệm như Resource budget đã ghi — tận tình trong lời, không phung phí trong tài nguyên.

## Definition of done

`bun run typecheck` · `bun test` · `bun run build` on what you touched — plus, for
cockpit UI changes, `bun run build` there and a look at the running app (screenshot or
a live CDP read of the computed styles). If a check could not run in your environment,
say which and why; never report an unfinished check as green.
