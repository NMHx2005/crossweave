# crossweave M1 — known limitations carried into M2

**Date:** 2026-08-10
**Status:** M1 implemented via subagent-driven development, 11 tasks, per-task review,
one whole-branch final review, one fix wave, one scoped re-review. Everything below is a
deliberate carry, not an unknown. Each was found by review, adjudicated, and left in place
with a reason.

M1's two DoD-breaking bugs — a cross-session port-allocation race and a daemon-restart data
loss bug — were caught by the final whole-branch review (neither was visible to any single
task's scoped review) and fixed in one wave, independently re-verified. See
`docs/superpowers/plans/2026-08-10-crossweave-m1.md`'s `docs(plan): sync ...` commits for
the full before/after detail on each. What follows is what survived that process as an
accepted gap, not a defect in shipped behaviour.

---

## 1. Resource leaks through the disposal paths gc doesn't own

**`cw session rm` and `cw session kill --rm-worktree` leak a session's cache directory and
copied database.** The final review's fix wave taught `collectGarbage`'s ended-session loop
to delete a reclaimed session's leased `cache`/`db` paths (`.crossweave/cache/<id>`,
`.crossweave/db/<id>.db`) before the row's cascade-delete removes the lease rows that name
them. `SessionManager.remove()` and the tail of `kill --rm-worktree` dispose a session
through a different path — `sessions.delete(row.id)` called directly — that never got the
same treatment. The lease rows are gone the instant the session row is, so nothing can find
those paths afterward. Same class of leak the fix wave closed for `cw gc`, different door.

**Cache/db bytes are still invisible to the disk budget.** `measureWorktrees`, which
`assertDiskAvailable` reads, is keyed on `SessionRow.worktreePath` only. A session's cache
directory can grow arbitrarily (it exists specifically because build caches are the thing
that grows) with zero effect on whether `cw session new` refuses for being over budget.
Wiring this in needs a join against the lease table and a decision on how (or whether) to
attribute a `schema`-strategy db lease, which has no bytes — deferred as more than the small
fix the final fix wave's own scope allowed.

---

## 2. `ports.named` can still silently override `PORT`

The reserved-name denylist added to `loadConfig`'s validation protects `PATH`, `HOME`,
`SHELL`, `USER`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, the two macOS `DYLD_*` equivalents,
`CW_SESSION_ID`, `CW_SESSION_NAME`, and `CW_PORT_BASE` — but not `PORT` itself.
`LeaseManager.acquire` sets `env.PORT` before the `named` loop runs, so a `named` entry
called `PORT` still silently wins. One-line fix (add it to the denylist); not done because
it was found during the final re-review, after the fix wave's findings list had already
been fixed and re-verified, and there is no second fix wave per this project's SDD process.

---

## 3. A malformed config now hard-fails every command, including the recovery one

Before M1, `crossweave.config.json` was only read inside the daemon; a live daemon kept
serving `cw session list` etc. even after the config file was corrupted underneath it. The
`CONFIG_INVALID` fix (loading the config in the foreground CLI, in `withClient`, before a
daemon can be spawned) means every command — including `cw gc`, the command a user reaches
for to recover disk space — now hard-fails against a broken config file, even when a healthy
daemon is already running and would have served the request fine. This is fail-closed and
was judged the correct trade-off (a config the user cannot trust should not be silently
worked around), but it is a real behaviour change from M0, worth knowing about if a future
milestone wants commands that legitimately don't need the config (like `cw gc` against an
already-running daemon) to tolerate a broken file.

---

## 4. Correct fixes with known, accepted narrowness

| Fix | Why the gap is accepted |
|---|---|
| Same-session concurrent-start guard (`starting` `Set` in `src/daemon/methods.ts`) reuses the `SESSION_ALREADY_RUNNING` error code for a "still starting" state that isn't literally "running" yet. | Naming nit, not a behavioural gap — callers only match on `.code`, and both states resolve to the same caller-facing advice ("wait and retry"). |
| `collectGarbage`'s `disposedPaths` double-listing guard (prevents a worktree whose `removeWorktree` failed in the ended-session loop from being double-reported by the orphan loop) has no dedicated regression test exercising an actual `removeWorktree` failure. | Verified correct by code reading during the final re-review; the failure mode it guards is itself rare (a worktree removal genuinely failing mid-gc). |
| `directorySize`'s catch is type-blind — an `EACCES` on an unreadable subdirectory is swallowed identically to an `ENOENT`, silently under-reporting that session's disk usage. | Documented as intentional in the doc comment: under-counting one unreadable subtree beats refusing to start a session over a permissions problem the user may not control. |
| `LeaseManager.acquire` has no rollback if the `db` step throws after port/docker/cache leases are already recorded — they leak (in the lease table, not on disk) until the session's next `release`/`releaseAll`. | Verbatim brief-mandated behaviour, not introduced by any implementer; self-heals on session stop or daemon restart (`releaseAll`). |
| The `schema` db strategy's query-string branching (`?` vs `&` before `options=`) has zero direct test coverage — only `file-copy` is exercised. | Carried from the original task; the branch reads correctly, just unexercised. |
| The socket `'error'`-listener regression guard (Task 2) is confirmed unreachable on macOS — `Daemon.close()` only raises `'end'`/`'close'` there, never `'error'`. | Pre-authorized by the task's own brief; Linux behaves differently (`ECONNRESET`), so the guard is real on that platform. Reported honestly rather than forced to pass. |
| citty's bare, unprefixed "Missing required positional argument" error (violates the DoD's one-line `CODE:` contract) is fixed for `session stop` only. | The task that closed this was explicitly scoped to `session stop`; `session kill`/`rm`/`rename`/`attach` and the `workspace` subcommands still have the gap on a missing positional. Mechanical fix (copy `stop`'s `required: false` + explicit guard) whenever this is picked up. |
| `loadConfig` returns the shared `DEFAULT_CONFIG` object by reference when no config file exists. | Checked twice — once with no live consumer, once after Tasks 6-11 added real ones (`buildMethods`, `SessionManager`, `LeaseManager`) — and confirmed none of them mutate the returned object. Still worth a `Object.freeze` as cheap insurance if a future consumer does. |
| `SessionRepo.clearWorktree` is dead in production code, still exercised by a test. | Genuine cleanup candidate, low priority. |

---

## 5. Process notes for whoever picks up M2

The two DoD-breaking bugs in this milestone (the port race, the boot-gc data loss) were both
**correct-looking code that a task-scoped review could not have caught** — each depended on
a cross-task interaction (Task 7's allocator + Task 9's unserialized dispatch; Task 11's
combined gc function + its own boot-time caller) that only became visible once the whole
branch was reviewed together, and both were confirmed with an actual concurrent/restart
repro, not by reading code. The whole-branch final review earned its place in the process on
this milestone; don't skip it under time pressure.
