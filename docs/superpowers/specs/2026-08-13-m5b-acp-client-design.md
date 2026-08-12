# M5b — ACP client for Cursor

## 1. Positioning

The roadmap's M5 (`docs/superpowers/specs/2026-08-09-crossweave-design.md` §6) bundles an ACP
client with Cursor support, and flags an explicit open research item before either can be
designed: "verify whether Claude Code and Cursor Agent speak ACP natively or require a bridge."
M5a (already shipped) closed the *other* half of M5 — Safe Mode blocking for the existing Claude
Code hook path — deliberately leaving ACP for later, once that question was answered.

It has now been answered, with primary-source evidence (GitHub issue threads, npm registry,
the protocol's own canonical docs and machine-readable schema, fetched 2026-08-13):

- **Cursor CLI speaks ACP natively.** `cursor-agent agent acp` is a first-class subcommand — no
  bridge process, no third-party dependency.
- **Claude Code does not.** Every path from Claude Code into ACP goes through a third-party
  translation layer (currently `@agentclientprotocol/claude-agent-acp`, formerly Zed-maintained);
  Anthropic has not committed to native support, and the tracking issue
  (`anthropics/claude-code#6686`) was closed by inactivity, not resolution. Multiple users report
  "lost in translation" bugs against the bridge.

**M5b is the Cursor-via-native-ACP path only.** Wiring Claude Code through the third-party bridge
is deliberately out of scope: Claude Code's own T2 (hook-based) path, shipped in M5a, remains its
only enforcement path for now. Revisit if Anthropic ships native support, or if a bridge proves
reliable enough to depend on for real enforcement — not before.

### Non-goals

- No Claude Code ACP bridge.
- No structured-event redesign of `AgentAdapter`/`AgentProcess` — ACP's rich content/tool-call
  events are translated down into the existing text-shaped interface (§3.1). A structured channel
  is M6 (TUI) territory, not M5b's.
- No human-in-the-loop permission prompting. The ACP permission handler reuses M5a's existing
  auto-decide policy (`blocked` → deny, else → allow) verbatim, just over a different call path.
  ACP's protocol *can* support a client that pauses and asks a human before responding — crossweave
  doesn't have the UX for that yet, and building it isn't this milestone's job.
- No wiring of crossweave's per-session MCP server into the ACP session's `mcpServers` field, even
  though ACP has a native slot for it and the existing MCP server (`src/mcp/server.ts`) is
  currently unconnected to any agent (Claude Code included — confirmed no adapter passes an
  `--mcp-config`-equivalent flag anywhere in the codebase). Real, but separate work, for both agent
  kinds at once — not scoped to "while touching Cursor."

## 2. Research findings that shape this design

(Full findings recorded in this design doc rather than a separate research doc — there's no
follow-on milestone that needs them independent of this one.)

- **Protocol**: JSON-RPC 2.0 over stdio, editor spawns the agent as a subprocess. Maintained at
  `github.com/agentclientprotocol` (organizationally separate from `zed-industries`, but still
  Zed-staffed). Schema is versioned and stable (`schema-v1.20.0` at research time); `protocolVersion`
  only bumps on breaking changes.
- **Official TypeScript SDK exists**: `@agentclientprotocol/sdk` (the renamed, current package —
  the old `@zed-industries/agent-client-protocol` name is deprecated). Exports connection helpers
  for both agent- and client-side roles; crossweave plays the client role via `ClientSideConnection`.
  No hand-rolled JSON-RPC framing needed.
- **`session/request_permission`** is the direct analogue of Claude Code's `PreToolUse` hook, but
  strictly stronger:
  - Sent agent → client, **before** the tool call executes, as an ordinary blocking JSON-RPC
    request — the agent's turn is paused until the client responds. No 5-second hook timeout to
    race against.
  - `toolCall.locations: { path: string (absolute), line?: number }[]` — the file(s) a tool call
    touches, structured, not a single `tool_input.file_path` string scraped from one tool's args.
    Can be multiple files in one call.
  - `toolCall.kind: 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch'
    | 'switch_mode' | 'other'` — semantic operation type. Crucially, **`execute` is covered by the
    same permission gate as `edit`** — ACP's boundary sits below every tool call the agent makes,
    not just an `Edit|Write`-shaped subset. This is exactly the gap M5a's known-limitations doc
    named as the reason T1 outranks T2 (`docs/superpowers/specs/2026-08-12-m5a-known-limitations.md`).
  - The client responds with one of the agent-offered `PermissionOption`s:
    `allow_once | allow_always | reject_once | reject_always` — a real, synchronous deny.

## 3. Design

### 3.1 `AcpAdapter` — squeezed into the existing `AgentAdapter` interface

`AgentAdapter`/`AgentProcess` (`src/adapters/types.ts`) are shaped entirely around PTY passthrough
— `write(data: string)` is a raw keystroke, `onData(chunk: string)` is a raw terminal byte stream,
`resize(cols, rows)` is a terminal concept. ACP has none of these; it exchanges structured
JSON-RPC. Rather than redesign the adapter interface now (deferred to M6, §1 Non-goals),
`AcpAdapter` translates:

| `AgentAdapter`/`AgentProcess` member | ACP translation |
|---|---|
| `kind` | `'cursor'` |
| `enforcementTier` | `'T1'` |
| `spawn(opts)` | Spawns `cursor-agent agent acp` as a child process (`opts.cwd` as its cwd), performs the `initialize` handshake, then `session/new({ cwd: opts.cwd, mcpServers: [] })`. Returns an `AgentProcess` wrapping the live `ClientSideConnection` + session id. |
| `write(data)` | `session/prompt({ sessionId, prompt: [{ type: 'text', text: data }] })` |
| `onData(cb)` | Subscribes to `session/update` notifications for this session. Text-producing update variants (agent message chunks) are concatenated and passed to `cb` as-is. Tool-call update variants are rendered to one readable bracketed line (`[cursor: edit src/x.ts]`, `[cursor: execute npm test]`) and also passed to `cb` — existing scrollback/`cw session attach` need no changes. |
| `resize(cols, rows)` | No-op — ACP has no terminal concept. |
| `kill(signal)` | Terminates the child process. |

`AcpAdapter` also implements the **client side** of `session/request_permission` (this is the
actual point of T1, not a translation detail):

1. For every `location` in `toolCall.locations`, resolve the absolute `path` to worktree-relative
   (same `assertContained` + `relative()` pattern `runRadarHook` already uses for the hook path —
   reused, not reinvented).
2. Call the shared blocking-decision function (§3.2) for each resolved path.
3. If **any** location's decision is `blocked`, respond with the agent's `reject_once` option; if
   none are, respond with `allow_once`. (`allow_always`/`reject_always` are never selected — M5a's
   policy is evaluated fresh on every call, matching the existing "no default was ever silently
   chosen" posture of this project. Session-scoped remembered decisions are a UX nicety, not a
   safety requirement, and out of scope here.)
4. A `toolCall.locations` that is empty or absent (a `kind: 'execute'` call whose agent-side ACP
   implementation didn't report file paths, for instance) has nothing to check against and is
   allowed — this is the M5b-specific known limitation (§5), not a new decision to make now.

### 3.2 Shared blocking-decision function — the actual point of this refactor

`radar.check`'s RPC handler (`src/daemon/methods.ts`, built in M5a Task 5) currently computes
`blocked` inline: `workspaces.resolve(workspaceId).safeModeTier`, the calling session's
`enforcementTier`, and `checkCollisions`. This logic is extracted into a plain function —
`decideBlocked(deps, { workspaceId, sessionId, path, symbol }): { collisions, blocked }` in
`src/radar/decision.ts` — that both `radar.check`'s RPC handler and `AcpAdapter`'s permission
handler call directly.

This is a simpler reuse than M5a's own design note anticipated ("a future ACP permission-boundary
handler needs the identical decision, just delivered over a different channel"): `AcpAdapter` runs
*inside* the daemon process (adapters are constructed by `SessionManager`, which lives in
`buildMethods`), not as a separate subprocess talking over the RPC socket the way `cw radar-hook`
does. So this isn't "the same decision over a different transport" — it's the same function,
called directly, with no transport at all on the ACP side.

**Consequence for adapter construction:** `AcpAdapter` needs access to daemon-internal state
(`FileClaimRepo`, `WorkspaceRepo`, `SessionRepo`) to call `decideBlocked`, which the current
`createAdapter(kind: string): AgentAdapter` factory signature (`src/adapters/registry.ts`) has no
way to provide — it's a plain, dependency-free factory today because `ClaudePtyAdapter` needs
nothing beyond its constructor args. `createAdapter` gains an optional second parameter carrying
the repos `AcpAdapter` needs; `ClaudePtyAdapter`'s construction is unaffected. `buildMethods`
(which already owns every one of these repos) is where the factory closure gets built either way.

### 3.3 Workspace tier gate: M5a's T1 rejection is lifted

`WorkspaceManager.setSafeMode` (`src/domain/workspace.ts`, M5a) currently throws
`SAFE_MODE_TIER_UNAVAILABLE` for `tier === 'T1'` — deliberately, because no T1 adapter existed
yet and accepting it would have claimed stronger enforcement than the system could provide. That
adapter now exists. The check is removed; `T1` becomes a normal, settable tier alongside `T2`/`T3`.
`setSafeMode`'s existing behavior for `T2`/`T3` is untouched.

### 3.4 CLI surface

`cw session new --agent cursor` becomes valid (`createAdapter('cursor')` succeeds instead of
throwing `UNKNOWN_AGENT`). No other CLI surface changes — `cw workspace safe-mode T1` already
exists as a code path (it just always threw before now); no new subcommand needed.

## 4. Data flow

```
Cursor agent (cursor-agent agent acp subprocess) wants to edit a file
  -> sends session/request_permission { toolCall: { kind: 'edit', locations: [{ path: '/abs/…' }] } }
  -> AcpAdapter's permission handler (inside the daemon):
       resolve each location to worktree-relative path
       -> decideBlocked(deps, { workspaceId, sessionId, path, symbol: undefined }) per location
       -> ANY location blocked?
            yes -> respond { outcome: 'selected', optionId: <reject_once> }
            no  -> respond { outcome: 'selected', optionId: <allow_once> }
  -> Cursor's tool call proceeds or never executes, matching the response
```

Compare to M5a's Claude Code path: same `decideBlocked` policy, no `cw radar-hook` subprocess, no
RPC round-trip on the ACP side (the daemon is answering its own permission handler, in-process),
no 5-second hook timeout.

## 5. Known limitation, stated honestly (new, M5b-specific)

Whether a given tool call reports `locations` at all is up to **Cursor's own ACP implementation**,
not crossweave — `AcpAdapter` can only check paths it's told about. This is a materially different
kind of gap than Claude Code's hook-matcher blind spot (M5a): that one is *structurally*
impossible to close (a hook cannot parse arbitrary shell for intent); this one is
*implementation-quality* dependent on Cursor's own ACP support and could close entirely, silently,
the next time Cursor improves its `locations` reporting — or open wider if it regresses. Goes into
a new `docs/superpowers/specs/2026-08-13-m5b-known-limitations.md`, following the M0-M5a
convention, at implementation time.

## 6. Testing

`cursor-agent` cannot be a test dependency — it's an external binary requiring a real Cursor
account/login, unavailable in CI. Tests use a **minimal fake ACP agent**: a small subprocess
(implemented with `@agentclientprotocol/sdk`'s own agent-side `agent()` helper, so the fake speaks
real, spec-correct ACP framing) that `AcpAdapter`'s tests spawn instead of the real binary — the
same pattern `ClaudePtyAdapter`'s existing tests already use (`sh -c '…'` fake commands instead of
a real `claude` install). The fake agent needs to be scriptable enough to: complete a normal
`initialize`/`session/new` handshake, echo a `session/prompt` back as a text update (proving the
`write`/`onData` translation), and — the actual point — fire a `session/request_permission` with a
controllable `toolCall.locations`/`kind` on command, so tests can assert the resulting
`allow_once`/`reject_once` choice against seeded `file_claim`/`safeModeTier` state exactly the way
M5a's `radar.check` blocked-matrix tests do.

- `decideBlocked` (extracted, §3.2): unit tests are M5a's existing `radar.check`-blocked tests,
  moved/adapted to call the function directly — no behavior change, pure extraction.
- `radar.check` RPC handler: thin wrapper test confirming it still returns the same shape,
  now via the extracted function.
- `AcpAdapter`: translation tests (`write`→prompt, update→`onData` text, tool-call update→
  bracketed line) against the fake agent; permission tests (multi-location, mixed blocked/clean,
  `kind: 'execute'` with and without locations) against the same shared blocked-matrix fixtures
  M5a already established.
- `createAdapter('cursor')`: constructs an `AcpAdapter` with `enforcementTier: 'T1'`.
- `WorkspaceManager.setSafeMode`: existing T1-rejection test is replaced with a T1-acceptance test
  (mirrors T2/T3's existing test shape).

## 7. Out of scope / deferred

- Claude Code ACP bridge (§1).
- Structured event channel for `AgentAdapter`/`AgentProcess` (§1) — M6.
- Human-in-the-loop permission prompting (§1).
- Wiring the per-session MCP server into `session/new`'s `mcpServers` field (§1) — separate,
  agent-kind-agnostic work.
- `allow_always`/`reject_always` session-scoped memory (§3.1) — UX nicety, not required for parity
  with M5a's policy.
