# crossweave M5b — known limitations

Accepted gaps carried out of M5b (ACP client for Cursor), found and deliberately deferred
during implementation — see `docs/superpowers/specs/2026-08-13-m5b-acp-client-design.md`
for the full design this summarizes.

## Blocking quality depends on Cursor's own `locations` reporting, not crossweave

`AcpAdapter` can only check the file paths a tool call actually reports in
`toolCall.locations` — if Cursor's ACP implementation doesn't populate `locations` for a
given call (a `kind: 'execute'` shell command it chooses not to attribute to specific
files, for instance), that call has nothing to check against and is allowed
(`src/adapters/acp.ts`'s `decideRequestPermission`, "no locations on the tool call" case).

This is a materially different kind of gap than Claude Code's hook-matcher blind spot
(M5a): that one is *structurally* impossible to close (a hook cannot parse arbitrary
shell for write intent). This one is *implementation-quality* dependent on Cursor's own
ACP support, entirely outside crossweave's control, and could close — or widen — the next
time Cursor's `cursor-agent` changes how it reports tool calls, with no code change on
crossweave's side either way.

## T1 fails closed on internal errors; T2 (the Claude Code hook) fails open — deliberately different

`decideRequestPermission` denies (not allows) on any unexpected internal error — a missing
`CW_SESSION_ID`, `decideBlocked` throwing, or a path-resolution failure that is NOT a plain
worktree escape (a location genuinely outside the session's worktree is skipped, not
denied — the same precedent the Claude Code hook already established; anything else, like
a symlink loop, denies). This is the opposite
of the Claude Code hook's fail-open posture
(`docs/superpowers/specs/2026-08-12-m5a-known-limitations.md`), and the difference is
deliberate, not an inconsistency: the hook is a separate subprocess with genuine
daemon-unreachable/timeout failure modes it must degrade through gracefully; `AcpAdapter`'s
permission handler runs in-process, in the same daemon that would have to be broken for it
to fail at all — an error there is a real bug, not legitimate unreachability, and T1 is
supposed to be the strong enforcement tier.

## No `child.on('error', ...)` coverage beyond spawn failure; no production error-visibility channel

`AcpProcess` handles a `spawn` failure (e.g. `cursor-agent` missing from `PATH`) by routing
it through the same exit-notification path as a normal process exit. But once spawned,
connection-level failures inside the constructor's async handshake (`initialize`/
`session/new` rejecting, the ACP subprocess crashing mid-handshake) are caught and silently
swallowed (`.catch(() => {})`) rather than surfaced anywhere — `AgentProcess` has no error
channel in its interface today, only `onData`/`onExit`. A `write()` issued after such a
failure queues forever in `pendingWrites` with no signal to the caller that anything is
wrong. This is not a regression this milestone introduced — `ClaudePtyAdapter`'s own
`fanOut` swallows subscriber errors the same way, for the same reason ("nowhere to log it
yet") — but it is a real gap worth closing whenever a production error-surfacing channel is
added (M6/TUI is the natural place, since it's already where richer per-session status
belongs).

## No Claude Code ACP bridge, no human-in-the-loop prompting, no MCP-server wiring

All three were explicitly out of scope for M5b (design doc §1) and remain so:

- Claude Code has no ACP path in crossweave — it stays on its M5a hook (T2) path. Anthropic
  has not shipped native ACP support; the only alternative is a third-party bridge
  (`@agentclientprotocol/claude-agent-acp`), deliberately not depended on for real
  enforcement (see the design doc's positioning section for the research this rests on).
- ACP's `session/request_permission` can, by protocol design, be answered as slowly as a
  client likes — crossweave doesn't use that: `AcpAdapter` always answers immediately with
  M5a's existing auto-decide policy, never pausing to ask a human. Building that UX is
  future work, not this milestone's.
- ACP's `session/new` has a native `mcpServers` field crossweave doesn't populate —
  crossweave's own per-session MCP server (`src/mcp/server.ts`) stays unconnected to any
  agent, Cursor included, exactly as it was for Claude Code before this milestone.
