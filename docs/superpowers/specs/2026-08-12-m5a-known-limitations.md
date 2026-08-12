# crossweave M5a — known limitations

Accepted gaps carried out of M5a (Safe Mode blocking for the Claude Code hook path),
found and deliberately deferred during subagent-driven implementation and the final
whole-branch review — see
`.superpowers/sdd/2026-08-12-m5a-safe-mode-blocking/progress.md` for the full
task-by-task ledger this doc summarizes.

## Hook coverage is `Edit`/`Write` only — `Bash`-tool writes are never intercepted

The `PreToolUse` hook's matcher (`radarHookSettings()` in
`src/adapters/claude-pty.ts`) is anchored to exactly `Edit` and `Write` — an agent
that writes a file through the `Bash` tool (shell redirection, `sed -i`, etc.) is
never intercepted, blocked or advised. This is inherent to hook-based (T2)
enforcement, not a bug: a hook cannot reliably parse arbitrary shell for
file-write intent, and widening the matcher to include `Bash` would not close
this honestly. It is exactly the gap ACP's structured permission boundary (T1)
closes, and is the reason T1 outranks T2 in the tier model. `NotebookEdit` was a
second, narrower version of this same class of gap during development — Claude
Code's `matcher` field is an unanchored regex, so the unanchored `'Edit|Write'`
originally shipped also matched `NotebookEdit` calls the hook's own
`WATCHED_TOOLS` set silently dropped; the matcher is now anchored
(`'^(Edit|Write)$'`) so the adapter and the hook agree exactly on what they cover.

## `cw workspace safe-mode T3` has no auth boundary — an agent can self-disable blocking

Turning Safe Mode off is a single unauthenticated RPC call
(`workspace.setSafeMode`), reachable from any session's `Bash` tool via the CLI.
An agent that has just been denied a write has both the motive and the means to
run `cw workspace safe-mode T3` and disable blocking workspace-wide for every
other session too — a materially larger blast radius than the `Bash`-write gap
above, which only evades one write for one session.

**Not fixed in M5a, deliberately**: no auth/trust model exists yet to gate this
kind of self-service config change, and building one is a real design decision,
not a patch. The mitigation that IS in place: the hook's deny reason
(`permissionDecisionReason`) never names the disable command or otherwise hints
at how to turn blocking off — an agent has to already know the CLI surface to
exploit this, not learn it from being blocked. Any future change to the deny
message text must preserve that property.

## Fail-open posture: a broken daemon, a slow hook, or a stale session silently downgrades a block to an allow

Three distinct paths all resolve to `allow()` rather than `deny()` when something
about the daemon-side check goes wrong, all deliberately in the fail-open
direction (a broken daemon must not brick the agent):

- `runRadarHook`'s outer `try`/`catch` returns `allow()` on ANY thrown error —
  daemon unreachable, RPC failure, a cold daemon start, anything.
- The hook's own timeout (`radarHookSettings()`, 5s) is non-blocking on Claude
  Code's side: a timed-out `PreToolUse` hook is treated as if it had allowed.
  The critical path a block has to complete inside that 5s window is: spawn
  `bun` → a `git rev-parse` subprocess → `loadConfig` → `connectOrStart`
  (**which may cold-start the whole daemon**) → `workspace.init` RPC →
  `radar.check` RPC. Before M5a this timeout only cost a missed advisory; now it
  can cost a missed block, which makes 5s a security-relevant number, not just a
  UX one.
- `radar.check`'s RPC handler resolves the calling session
  (`sessions.resolve(workspaceId, sessionId)`) unconditionally, which throws
  `SESSION_NOT_FOUND` for a session killed with `--rm-worktree` while its agent
  process is somehow still alive and firing hooks. This is a new, currently
  untested error path (the handler used to only pass `sessionId` through as an
  opaque filter to `checkCollisions`, never resolving it) — it degrades to
  `allow()` via the same outer catch, the correct direction, but has no
  regression test pinning that it stays that way.

None of these are changed in M5a — the fail-open direction is correct and
intentional throughout — but they are now security-relevant decisions that
should be treated as such if any of them is ever revisited, not an inherited
default nobody decided on.

## `blocked`'s shape is a bare boolean — ACP's permission model is tri-state

`radar.check` returns `blocked: boolean`. ACP's own permission model (relevant to
a future M5b) is `allow` / `ask` / `reject`, not binary — a bare boolean cannot
represent "ask the user" without another RPC shape change later. Widening
`radar.check` to return a reason code alongside `blocked` (e.g.
`'no-collision' | 'workspace-tier' | 'session-tier' | 'blocked'`) would be
additive and let a future ACP handler prompt rather than hard-deny; not done in
M5a because nothing consumes it yet. Relatedly, the deny message text itself
currently lives in the hook (`collisionMessage()` in
`src/cli/commands/radar-hook.ts`), not next to the `blocked` policy in
`radar.check` — an ACP handler will otherwise have to re-implement that text
from scratch, and the two copies will drift.
