# Horizon A — Deck bridge: what is actually built

**Date:** 2026-09-21
**Milestone:** Horizon A of `2026-09-21-long-roadmap-spacevibe-crossweave.md`
**Design:** `2026-10-01-deck-crossweave-bridge-design.md`
**Status:** skeleton — the bridge module exists and typechecks; nothing in the product
calls it, and no Deck code was touched.

## What exists

- `src/deck/bridge.ts` — `DeckBridge`: `connect()` over `ClientTransport` (unix socket,
  `wsTransport`, or an injected transport), `listWorktrees(workspaceId)` mapping
  `session.list` rows to a flat card shape, `land(workspaceId, sessionId)` as a
  passthrough to `land.session`, and `onEvent` as a passthrough to the client's
  notification fan-out.
- `tests/client/deck-bridge.test.ts` — one test over a hand-wired in-memory transport
  pair, asserting only that `listWorktrees` returns the branch the stub replied with.

That is the whole of Horizon A. The five tasks the roadmap listed are not done:

| Roadmap task | State |
|---|---|
| 1. Bridge process | Partial. The module exists but has **no call site**: `DeckBridge` is referenced only by its own file and its test — no entry point constructs it, no Deck extension/sidecar registers it, and it is not exported from any CLI/daemon surface. |
| 2. Worktree card mapping | Not done. `heading` is the session id, not a Deck card heading, and colour/dot/selected-frame are absent. Deck's worktree creation flow and its partial-checkout guard are untouched. |
| 3. Attention mapping | Not done. There is no `deriveAttention` → rail mapping and no latest-words tail from `session.data`. It also cannot be done from the engine as it stands: `deriveAttention` lives in the renderer (`apps/cockpit/src/lib/attention.ts`), so there is no engine-side attention model for a bridge to share. |
| 4. Land from Deck | Not done. `land()` is an RPC passthrough with no caller: no card button, no command-palette entry, no blocked-reason surface, no re-fetch after a land. |
| 5. File open | Not done. Cmd+click into a session's own worktree exists nowhere. |

## `needs_you` is still unreachable

The design's §2 asked this horizon to wire the first real `waiting` signal. It was not
wired: `src/db/repositories/session.ts` still documents `waiting` as UNREACHABLE, and the
statuses anything actually writes are `running`, `idle`, `dead` and `landed`. The cockpit
rail's `needs_you` badge therefore still fires only from `recentBlocked` and landability,
exactly as `2026-09-17-tier-coverage-honesty-design.md` described — a bridge that maps attention
kinds today would map five of the six, and would mis-claim the sixth.

## The gate was not run

The design's gate was `Deck dev with 2 live sessions, land one, badge changes`. No Deck
checkout, and no live session pair, was involved. What was actually verified is
`bun run typecheck` plus the in-memory unit test above.

`docs/PROGRESS.md` listing Horizon A as DONE was ahead of the code; this document is the
correction, and that line is now marked as a skeleton.

## What this means if you rely on it

Do not expect to drive crossweave from Deck. The CLI/TUI and the Cockpit remain the only
clients that reach the daemon today. The card shape in `bridge.ts` is a draft, not a
contract — nothing consumes it, so it may change freely until something does.
