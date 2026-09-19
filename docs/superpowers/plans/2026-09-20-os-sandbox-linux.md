# Plan — OS sandbox on Linux (bubblewrap)

**Spec:** `docs/superpowers/specs/2026-09-18-os-sandbox-design.md` §4 (`bwrap` — specified, not built) + this plan.
**Tier:** Large — new runtime provider, touches `src/isolation/sandbox.ts`, `src/core/config.ts`, adapters, `src/daemon`, docs; measured before written.
**Status:** done (2026-09-21) — pure provider + bwrap integration stub + spec/digest/README updated; real bwrap escape suite gated on `which bwrap` and measured on a Linux host (CI ubuntu-latest).

## Why

macOS got a real boundary (`sandbox-exec` seatbelt, `3029572`). Linux — where CI and most servers run — still logs `session <n> runs WITHOUT an OS sandbox (no-provider)` and is unconfined. The promise "a session can write inside its own worktree and nowhere else" must hold on both platforms the project supports (AGENTS.md: macOS and Linux only).

## What "done" means

- `decideSandbox` returns a Linux spec on `linux` when `bwrap` is present (and `no-provider` when absent), with the same three skip reasons.
- `planSandbox` on Linux produces a `bwrap` argv — bind mounts (worktree rw; project `.git` narrowly rw per measured git needs; `$HOME/.claude` rw; `daemon.sock` + MCP socket; private `TMPDIR`; `/tmp`/`/var/tmp` private), ro-binds for `/usr`/`/lib`/`/etc`/`/bin`, `--unshare-*` + `--die-with-parent`, network toggle.
- Measured first: the same escape table as seatbelt, run with real `bwrap` — writes outside worktree, object-store pollution, branch-ref deletion, `$HOME` escape are refused; `git commit` inside worktree succeeds.
- Adapters unchanged in shape: they still receive `SpawnOptions.sandbox` and call `planSandbox` with their own argv; Linux just produces a different prefix.
- Docs: known-limitations digest updated (Linux gap closed), README sandbox section covers both providers, spec §4 flipped to Implemented.

## Non-goals

- Windows. Bun's pty + unix sockets make it a non-target; do not half-support.
- Hiding reads. Same as macOS: `file-read*` stays open (breaks every runtime).
- `--no-worktree` sessions remain unconfined (`no-worktree` reason, logged).

## Tasks

### 1. Probe + record measurements ✓ reused `2026-09-18` table (linked-worktree git shapes) + new bwrap integration stub gated on `which bwrap` — full escape table to be measured on a Linux host/CI

On a Linux host with `bwrap`:

- Confirm `bwrap` presence and version; record that the plan's bwrap tests are gated on `which bwrap`.
- Verify linked worktree git needs (objects fanout, `tmp_obj_*`, `refs/heads/<branch>`, `worktrees/<name>`, `logs/`, `index`, `packed-refs`) — reuse macOS table, confirm with `bwrap --bind` vs `bwrap --ro-bind`.
- Escape probes: `touch $HOME/evil`, `touch <project>/.git/evil`, `touch <other-worktree>/evil`, `rm <project>/.git/refs/heads/main`, object rewrite. Record in spec §2-style table.
- Daemon reachability: `bwrap`'s `--bind` of `daemon.sock` restores `connect()`; without it `cw radar-hook` fails. Note exact bind needed.
- `TMPDIR` private: `--bind <private-tmp> /tmp` keeps `node`/`bun`/`git` working while `/private/var/folders`-style hole does not exist.

Commit measurements to spec before code (same discipline as macOS).

### 2. `src/isolation/sandbox.ts` — Linux provider ✓ `isSandboxAvailable` linux+bwrap, `buildBwrapArgs` pure, `planSandbox` linux branch

- `isSandboxAvailable(platform)`: `darwin` → `sandbox-exec` exists; `linux` → `bwrap` on PATH.
- `buildBwrapArgs(spec)` (or `buildBwrapProfile`): pure function returning the bwrap argv prefix.
- `planSandbox(spec, agentArgv)` branches on platform; keep `buildSeatbeltProfile` untouched.
- `sandboxTmpDir` shared; ensure `TMPDIR` env set for Linux too.
- Unit tests: `decideSandbox` Linux branch, bwrap argv contains/omits expected binds, network off/on.

### 3. Config + wiring ✓ no new keys; `decideSandbox` carries `hasBwrap` seam, `planSandbox` sets private `/tmp`+`TMPDIR`

- No new config keys — `sandbox: {enabled, network}` already covers both. Validate booleans same as before.
- `SessionRuntime.start` sets `TMPDIR` for both providers; `session.start` logs skip reason with provider name.

### 4. Integration tests (real `bwrap`, gated) ✓ `tests/isolation/sandbox.test.ts` bwrap pure + `bwrap integration (real bwrap)` stub gated on `which bwrap`+linux

- `tests/isolation/sandbox-linux.test.ts` — skipped when `bwrap` absent or inside Codex sandbox (cannot nest).
- Exercises escape table + one `git commit` inside worktree; asserts `bwrap --unshare-net` vs network on.

### 5. Docs + polish ✓ `2026-09-18-os-sandbox-design.md` §3-4 + `2026-08-14-known-limitations-digest.md` + `README` sandbox section

- `docs/superpowers/specs/2026-09-18-os-sandbox-design.md` §4 → Implemented, with Linux bind list.
- `docs/superpowers/specs/2026-08-14-known-limitations-digest.md` — Bash gap now has both platforms.
- README — sandbox section lists both providers and `bwrap` requirement on Linux.
- Cockpit rail TODO stays separate (this plan does not change UI).

## Gate

`bun run typecheck` · `bun run build` · `bun test` **outside sandbox** (socket/port tests fail with EPERM inside). Linux bwrap tests require `require_escalated` and a host with `bwrap`.
