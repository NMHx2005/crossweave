# Plan — enforcement coverage, stated honestly

**Spec:** `docs/superpowers/specs/2026-09-17-tier-coverage-honesty-design.md`
**Status:** done — tasks 1–7 implemented; §"Out of scope" (the OS sandbox) remains a
proposal in the spec, deliberately not built.
**Tier:** Medium (7 files + their tests, spans CLI/daemon/radar/adapters, no schema or
public API change — `radar.reindex` is a new daemon RPC, additive).

## Global constraints

- A hook must never throw and never deny on a guess: the Bash path is advisory-only (§3.1).
- `decideBlocked` stays the single blocking policy; nothing here reimplements it.
- Tests must not depend on `fs.watch` delivery (sandboxed shells drop the notifications) —
  test the pieces (`reindexNow` body, path extraction, notify filtering), not the OS event.

## Tasks

1. **T1: a mutating call with no enumerable target denies.** `src/adapters/acp.ts`,
   `decideRequestPermission`: empty `locations` no longer means allow. Add a positive
   carve-out for `execute` (shell has no evaluable target in any tier — §2) so the fix
   does not turn T1 into "cannot run any command". Test: red on the old behaviour.
2. **Shell path extraction.** New `src/radar/shell-paths.ts` — pure, quoted-aware split,
   write-intent operators only, capped at 5 candidates, best-effort by contract.
   `tests/radar/shell-paths.test.ts` covers each operator, quoting, `cd`-relative noise,
   the cap, and the "tokens that are not paths" false-positive class.
3. **Bash in the hook, advisory only.** `src/cli/commands/radar-hook.ts`: `WATCHED_TOOLS`
   gains `Bash`; the Bash branch checks each extracted path and returns an advisory
   `allow` — including when the daemon says `blocked`. Tests: advisory on collision,
   **allow on `blocked`** (the regression this task exists for), no RPC at all when
   nothing path-like was found.
4. **`radar.reindex` RPC + immediate reindex.** `src/daemon/methods.ts` gains the RPC;
   `RadarWatcherRegistry` keeps its own `sessionId → session` map so it can reindex on
   demand, cancel the pending debounce tick, and notify only the paths the tool call
   touched (`notifyCollisions` gains an optional path filter, `retro-notify.ts`).
   Tests: filter behaviour, `reindexNow` with no watcher registered is a no-op, debounce
   cancellation.
5. **Hook wiring.** `src/adapters/claude-pty.ts`: `PreToolUse` matcher
   `^(Edit|Write|Bash)$`, new `PostToolUse` matcher calling `cw radar-hook post`. Tests:
   both matchers, and that the post entry point never prints a permission decision.
6. **Coverage labels.** New `src/adapters/coverage.ts` (the §2 table, machine-readable);
   `cw workspace safe-mode` / `cw session list` and the cockpit rail print
   `T2 · Edit|Write` instead of a bare tier. Tests: label for each tier, and that no
   surface prints a bare tier for T2.
7. **Docs.** Correct the digest's Bash paragraph (both halves: advisory, and the Radar
   *does* see it late), point the M5a design doc's "left as an accepted gap" line at this
   spec, and mark this plan done with the task→commit map.

## Out of scope

The OS-level sandbox (§5 of the spec) — a separate milestone with its own design doc.

## Task → commit map

| Task | Commit |
|---|---|
| 1. T1 denies a call with no enumerable target | `648c7d9` |
| 2. Shell path extraction (`src/radar/shell-paths.ts`) | `f4da8e7` |
| 3. Bash in the hook, advisory only | `f4da8e7` |
| 4. `radar.reindex` RPC + immediate reindex | `f4da8e7` |
| 5. Hook wiring (`^(Edit\|Write\|Bash)$`, `radar-hook post`) | `f4da8e7` |
| 6. Coverage labels (`T2 · Edit|Write`) | `ea26e7c` |
| 7. Docs (digest, M5a design doc, this plan) | this commit |

## Gate

`bun run typecheck` · `bun run build` · `bunx tsc` + `vite build` in `apps/cockpit` ·
`bun test`: **814 pass, 1 fail** — `compiled binaries > runs a real workspace lifecycle
from the binary alone`, which fails identically on `main` (`794 pass, 1 fail`).

Note for whoever runs this next: the suite must be run OUTSIDE the sandbox. Inside it,
~100 tests fail with `EPERM`/`NO_PORTS_AVAILABLE` because socket binds and port probes
are blocked — indistinguishable at a glance from a real regression, and it cost me one
misleading run before the escalated baseline showed the same suite at 1 failure.

## What was verified against something real (not just unit tests)

- A scratch repo + real CLI: `T2 · Edit|Write`, `safe mode: T3 · nothing`, and
  `workspace info`'s full sentence all print as intended; `radar-hook post` exits 0
  silently; a PreToolUse `Bash` call with no session context returns a plain allow.
- Red-before-green for task 1: both new cases fail against the previous handler.
- `reindexNow` against a real git fixture and a real `fs.watch` registration.
