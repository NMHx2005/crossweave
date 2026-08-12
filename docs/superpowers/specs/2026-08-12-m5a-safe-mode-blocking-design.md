# M5a — Safe Mode blocking for the Claude Code hook path

## 1. Positioning

The roadmap's M5 (`docs/superpowers/specs/2026-08-09-crossweave-design.md` §6) bundles four
things: an ACP client, upgrading Collision Radar's `PreToolUse` hook from advisory to
real blocking, Cursor support, and a `--trusted` flag. The ACP/Cursor pieces carry an
explicit open research question the original spec itself flags — "verify whether Claude
Code and Cursor Agent speak ACP natively or require a bridge" (§4.10) — and are not
needed for blocking to work on the path crossweave already has.

**M5a is the blocking upgrade only, scoped to the existing Claude Code PTY adapter.**
ACP client, Cursor support, and `--trusted` are deferred to later M5 sub-milestones once
the ACP research question is resolved.

### Non-goals

- No ACP client, no Cursor adapter, no `--trusted` flag.
- No change to Radar's detection logic (`checkCollisions`) or noise control for the
  advisory path — both are reused as-is.
- No attempt to intercept file writes made through the `Bash` tool (see §5, Known
  limitations).

## 2. Current state (verified by reading the code, not assumed)

- `ClaudePtyAdapter` (`src/adapters/claude-pty.ts`) is the only `AgentAdapter`
  implementation that exists. It already injects a `PreToolUse` hook
  (`matcher: 'Edit|Write'`) into every Claude Code invocation via an inline
  `--settings` JSON argument — scoped to that one process, nothing written to disk.
  Despite having a real interception point, it hardcodes
  `enforcementTier: EnforcementTier = 'T3'`.
- `runRadarHook` (`src/cli/commands/radar-hook.ts`) has exactly one response builder,
  `allow()`, and every code path calls it — there is no `deny` branch anywhere in the
  codebase today. `radar.check` (`src/daemon/methods.ts`) only ever returns
  `{ collisions }`.
- `workspace.safeModeTier` (`src/db/schema.ts`) is written once, hardcoded to `'T3'`, in
  `WorkspaceManager.init()` (`src/domain/workspace.ts`) and never read or written again
  anywhere in the codebase — a dead field.
- `session.enforcementTier` is always `adapter.enforcementTier`
  (`src/domain/session.ts`), so always `'T3'` today, for the same reason.

## 3. Design

### 3.1 Tier correction

`ClaudePtyAdapter.enforcementTier` changes from `'T3'` to `'T2'`. This matches the
roadmap's own definition (§4.10: "Claude Code natively (hooks + headless SDK + MCP),
giving T2") — the adapter already has the hook-based interception point T2 describes;
the old label just predates M3 wiring it up and was never revisited.

### 3.2 `workspace.safeModeTier` becomes a real, settable floor

- `WorkspaceRepo` gains `updateSafeModeTier(id: string, tier: 'T2' | 'T3'): void`.
- New RPC `workspace.setSafeMode({ id, tier })` — `id` to match every sibling
  `workspace.*` RPC (`info`, `delete`, `gc`), not `workspaceId` as an earlier
  draft of this doc said. `tier: 'T1'` is rejected with
  `SAFE_MODE_TIER_UNAVAILABLE` — no ACP adapter exists yet, so silently accepting T1
  would create a false sense of stronger enforcement than the system can actually
  provide. Anything other than `'T1' | 'T2' | 'T3'` (wrong case, garbage string) is
  rejected with `INVALID_PARAMS`, matching every other enum-shaped RPC param in
  `src/daemon/methods.ts`. `workspace.info` (already exists, confirmed to return the
  full `WorkspaceRow` including `safeModeTier`) continues to surface the current tier;
  no new read RPC is needed.
- New CLI `cw workspace safe-mode [T2|T3]` — no argument prints the current tier
  (`cw workspace safe-mode` → `T2`); with an argument, sets it.
- **New workspaces default to `T2`** (blocking on), not `T3` — `WorkspaceManager.init()`
  changes accordingly. Safety is the default; a user who wants today's advisory-only
  behavior runs `cw workspace safe-mode T3` explicitly.

### 3.3 Blocking decision moves server-side

`radar.check`'s RPC handler computes and returns one more field:

```
{ collisions: Collision[], blocked: boolean }
```

```
blocked = workspace.safeModeTier !== 'T3'
       && session.enforcementTier !== 'T3'
       && collisions.length > 0
```

Every claim in `collisions` already originates from a real write (§4.8: claims are
indexed only from files that diverge from the merge base) — there is no separate
"write-write" filter to add; any non-empty `collisions` already is that case.

This lives in the daemon, not in `runRadarHook`, because the policy ("is this session's
tier + this workspace's floor enough to block") is transport-independent — a future ACP
permission-boundary handler needs the identical decision, just delivered over a
different channel. Keeping it in one place means M5b reuses it instead of
re-implementing it.

### 3.4 `runRadarHook` gains a deny path

When `radar.check` returns `blocked: true`:

- The `NotificationGate` rate limit (6 notifications / 10 min, §4.8 noise control) is
  **bypassed entirely** — that throttle exists to protect token budget on advisory text,
  and must never suppress a safety-relevant block.
- The hook returns:
  ```json
  {
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "deny",
      "permissionDecisionReason": "crossweave Radar: session(s) auth also have divergent changes to src/auth.ts#AuthService. Blocked — this workspace's Safe Mode does not allow write-write collisions."
    }
  }
  ```
  (Schema confirmed against the official Claude Code hooks reference,
  `code.claude.com/docs/en/hooks.md`: `PreToolUse` decisions live under
  `hookSpecificOutput.permissionDecision` with `permissionDecisionReason` alongside it;
  Claude Code blocks the tool call before it executes and surfaces the reason to the
  agent, which can react to it like a tool error.)
- When `blocked: false`, the existing advisory path is unchanged byte-for-byte —
  `NotificationGate` still throttles it exactly as it does today.

### 3.5 Known limitation, stated honestly (not fixed in M5a)

The hook's `matcher` is `Edit|Write` only. An agent that writes a file through the
`Bash` tool (shell redirection, `sed -i`, etc.) is not intercepted — this is inherent
to hook-based enforcement, not a bug to patch here. It is exactly the gap ACP's
permission boundary (T1) closes, which is the whole reason T1 outranks T2 in the tier
model. Widening the matcher to include `Bash` would not close this honestly (a hook
cannot reliably parse arbitrary shell for file-write intent), so it is left as an
accepted, documented gap rather than a false fix.

## 4. Data flow

```
Claude Code agent calls Edit(file)
  -> PreToolUse hook (`cw radar-hook`) invoked, stdin carries tool_input + cwd
  -> hook resolves session via CW_SESSION_ID, calls `radar.check` RPC
  -> daemon: checkCollisions (unchanged) + workspace.safeModeTier + session.enforcementTier
  -> daemon returns { collisions, blocked }
  -> hook:
       blocked=true  -> deny, reason built from collisions, gate bypassed
       blocked=false -> existing advisory allow path (gate-throttled), unchanged
```

## 5. Testing

- `radar.check` RPC: `blocked` correct across the (T2, T3 workspace) x (has, has no
  collision) matrix, and across session `enforcementTier` T2/T3.
- `runRadarHook`: new deny-path unit tests (JSON shape, `permissionDecisionReason`
  content, gate bypass — asserted by triggering it more than 6 times in a row and
  confirming every one denies). Existing advisory tests unchanged.
- `cw workspace safe-mode`: get/set round-trip; rejects `T1` with
  `SAFE_MODE_TIER_UNAVAILABLE`; rejects garbage input.
- `ClaudePtyAdapter` / `createAdapter('claude')`: assertion updated from `'T3'` to
  `'T2'`.
- Regression: a freshly-created workspace's `safeModeTier` is `'T2'`.

## 6. Out of scope / deferred

- ACP client, Cursor adapter (blocked on the roadmap's own open research item).
- `--trusted` flag — `cw workspace safe-mode T3` already gives a workspace-level
  off-switch; a session-level or confirmation-bypassing `--trusted` is a separate UX
  decision for later, once there's real usage to design it against.
- Any change to how dead/landed sessions' claims participate in collision detection —
  already covered, and judged correct, in M3's known-limitations doc.
