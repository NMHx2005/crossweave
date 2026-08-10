# crossweave M2 — known limitations carried into M3

**Date:** 2026-08-11
**Status:** M2 implemented via subagent-driven development, 9 tasks, per-task review with
fix rounds where needed. Everything below is a deliberate carry, not an unknown. Each was
found by review, adjudicated, and left in place with a reason.

This M2 attempt is a redo. A first pass was committed directly to `main` without a worktree
or review, and a whole-branch review found it non-functional end to end: `cw blame` never
found anything (nothing ever wrote the events it read), broadcast messages were written but
never read by anyone, and a missing MCP socket error listener could crash the whole daemon.
That work was reset off `main` and rebuilt from a clean plan. This time, per-task review
caught two more genuine, behaviorally-confirmed defects that a first pass alone did not
surface — a `cw blame` early-return bug (only worked for brand-new files, not edits to
existing ones) and, more seriously, a daemon-restart bug where an ordinary crash or restart
permanently destroyed any session that was merely `running` at that moment, the same class
of bug as M1's boot-gc Critical #2. Both are fixed and independently re-verified with
behavioral probes, not just re-read. What follows is what survived that process as an
accepted gap, not a defect in shipped behaviour.

---

## 1. `cw blame` only attributes committed lines

An uncommitted change has no session to attribute it to under this design — there is no hook
yet that observes an agent's individual tool calls or file writes (`file.changed`,
`tool.call`); that arrives with M3's `PreToolUse` plumbing. `cw blame` says so plainly
(`no attribution found`) rather than guessing. This was a deliberate scope decision, not a
gap discovered late — see `docs/superpowers/plans/2026-08-10-crossweave-m2.md`'s Task 2.

**A narrower, related limitation:** blamed line numbers are not revision-qualified. `blame()`
tries `[baseBranch, ...sessionBranches]` in order and returns the first revision with a
tracked-session match; if a session's branch happens to have unrelated content at the exact
line index being asked about (e.g. the session prepended lines elsewhere in the file,
shifting everything below), that session can be attributed a line it never actually touched.
Confirmed by direct review probe, not theoretical. This is not a regression — the pre-fix
code returned `undefined` for the entire family of cases including correct ones — but it is
an inherent trade-off of the current design (fixing it properly means tracing the specific
line across revisions or restricting the search to revisions descending from the same base
content, materially more work than this milestone's scope).

**Blame history is lost once a session's row is deleted.** `event.session_id` cascades on
session deletion, same as M1's lease table. A session that's merely `kill`ed (not
`--rm-worktree`/`rm`/`gc`'d) keeps its full event history; a fully-reclaimed session's is
gone. Extending audit history to outlive the session row is a real but separate design change
(nullable `session_id`, or a durable append-only export) — not attempted here.

---

## 2. Reconciliation's pid-liveness check can be fooled by pid reuse

`isProcessAlive` is `process.kill(pid, 0)` — it proves *some* process holds that pid, not
that it's the same process this daemon spawned. After a daemon crash, if the OS recycles that
pid for an unrelated process before the next boot, reconcile will wrongly treat the session as
still alive (leaving it `running` when it should be `idle`). This is the same risk M0's and
M1's own known-limitations docs already named as the reason full reconciliation was deferred
that far. Verifying process identity across macOS/Linux without a native dependency is real,
cross-platform-fragile work with a low-probability payoff; this milestone closes the
worktree-existence and pid-liveness checks it can close honestly, and documents the residual
risk rather than either ignoring it or over-building a fix.

**What this milestone did fix, found only once reconciliation was wired live (Task 8):** the
first version of `reconcile()` treated "worktree gone" and "pid gone" as the same outcome —
both marked the session `dead` (terminal, unresumable, later `gc`-deleted). That made an
*ordinary* daemon restart (a crash, `cw daemon stop` for an upgrade, a host reboot)
indistinguishable from a deliberate `cw session kill`, silently destroying any in-progress
work that merely happened to be `running` at that moment. Fixed to distinguish the two: a
gone worktree really does mean nothing is left to resume (`dead` is correct); a gone pid with
the worktree still intact is treated the same as `cw session stop` — `idle`, resumable. See
the `docs(plan): sync reconciliation's dead-vs-idle status split` commit for the full
before/after.

---

## 3. Broadcast reaches sessions live at send time, not sessions that join later

`MessageBus.broadcast` fans out at send time to every currently-live session, one row per
recipient — a deliberate simplification over per-recipient delivery tracking for a
"anyone, ever" topic-style broadcast. A session that starts after a broadcast was sent simply
wasn't a recipient of it, the same way it wouldn't have been in the room for a message spoken
before it arrived. Documented in `src/domain/bus.ts`'s own class comment.

---

## 4. `cw_check` and `cw_declare_contract` do not exist

Both arrive with M3's Collision Radar. No MCP tool by either name is registered — an agent
that tries to call one gets a clean "unknown tool" MCP error, not a fake success. A prior,
reset M2 attempt shipped both as callable tools that always returned a hardcoded "no problem"
response, indistinguishable from a genuine "no collision" result to any agent decision logic
— worse than not having the tool at all, since an agent could act on the fake signal and
overwrite another session's in-flight work. Not repeated here.

---

## 5. The MCP transport has no bridge to a real stdio/SSE MCP client yet

The hand-rolled MCP server (`src/mcp/server.ts`) speaks correct MCP wire-protocol messages
(JSON-RPC 2.0, `initialize`/`tools/list`/`tools/call`, verified against the MCP spec's actual
schemas) over a raw unix domain socket. No coding agent's MCP client (Claude Code included)
connects to a raw unix socket directly — they speak stdio, SSE, or streamable HTTP. A
stdio-to-socket (or HTTP-to-socket) bridge is needed before a real agent can reach these tools
at all, and nothing in this milestone builds one. The message shapes are correct and tested
end-to-end via `session.mcpInfo` + a raw socket client in this milestone's own tests, but that
is not the same as a real agent being able to reach them yet. Confirm this bridge is planned
for M3 or another near-term milestone rather than assumed to already exist.

---

## 6. Correct fixes with known, accepted narrowness

| Fix | Why the gap is accepted |
|---|---|
| `session.mcpInfo`'s `listening()` check is a latch that doesn't reset when a server closes. In the brief window between the runtime's exit callback calling `handle.close()` and the map entry actually being deleted, `session.mcpInfo` can still hand back a path nothing is listening on. | Confirmed observable in a tight probe loop (2/27), not just theoretical — but it's a narrower version of a window that existed before this milestone's fix, not a new one, and the fix already closed the much larger "server never bound at all" case. One-line follow-up: read `netServer.listening` directly instead of a latch. |
| The message-handling `.catch()` added to prevent an unhandled rejection from killing the daemon (`src/mcp/server.ts`) is fully silent — a genuine bug in that path now produces no response and no log, and the client waits forever on that request id. | Crash-prevention was the explicit priority; a `process.stderr.write` inside the catch would restore debuggability at zero additional crash risk, but wasn't required by the finding that motivated the fix. |
| `MessageBus.broadcast`'s live-session filter hardcodes `['idle','running','waiting']` instead of reusing `SessionRepo`'s `LIVE_STATUSES` constant (module-private; `SessionManager` doesn't expose a `listLive()` accessor `MessageBus` could call). | Currently consistent (verified identical values); no compiler or test signal if the two ever drift apart. Would need a small `SessionManager` API addition to close, out of this task's file scope. |
| `reconcile()`'s two-condition split (Section 2 above) was found and fixed, but its fix round also self-corrected a genuine race the implementer introduced mid-fix (`session.mcpInfo` returning a socket path before the MCP server had finished attempting to bind). | The final state was independently re-verified race-free by a second reviewer with fresh behavioral probes (15/15 consecutive session starts immediately followed by a real socket connect, all reachable) — not just re-read. Noted here only so the fix's history is on record. |
| MCP server socket files (`cw-mcp-*.sock` under `os.tmpdir()`) are not cleaned up on `SIGINT`/`SIGTERM` — the daemon's signal handler closes only the RPC socket, not tracked MCP servers or running sessions. | Harmless in practice (session ids never repeat, so no collision risk; a stale socket file is unlinked automatically on the next attempt to bind that exact name, which never happens) but leaves files accumulating in `$TMPDIR` across ungraceful daemon exits. `daemon.shutdown` (the graceful RPC path) does close everything correctly. |
| `cw blame`'s local `interface BlameResult` in `src/cli/commands/blame.ts` duplicates the identical, already-exported `BlameResult` from `src/domain/ledger.ts` instead of importing it. | Harmless, matches an existing local-interface convention already used elsewhere in the CLI layer (`session.ts`'s own local `Session` interface) — a second copy of the same shape that could in principle drift, not a functional gap. |

---

## 7. Process note for whoever picks up M3

Both of this milestone's most serious defects — the `cw blame` early-return bug and the
daemon-restart-destroys-running-sessions bug — were caught by careful task-scoped review
tracing actual git/process semantics with real behavioral probes, not by reading code and
trusting that it matched the plan. Several review passes in this milestone explicitly ran
standalone scripts to reproduce a claimed bug *and* its claimed fix before accepting either.
That extra step is what caught both: a plausible-looking implementation of a subtle
distributed-systems-adjacent design (which git revision to blame, what a daemon restart
should mean for a session's status) is exactly the kind of bug that passes its own shipped
tests while still being wrong for the case those tests didn't happen to construct. Keep
budgeting for it.
