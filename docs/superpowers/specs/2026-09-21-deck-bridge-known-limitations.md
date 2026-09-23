# Horizon A — Deck bridge: what is built, and what is not

**Date:** 2026-09-21 → updated 2026-09-24 (`d99893d`)
**Milestone:** Horizon A of `docs/superpowers/plans/2026-09-21-long-roadmap-spacevibe-crossweave.md`
**Design:** `2026-10-01-deck-crossweave-bridge-design.md`
**Status:** wired (engine + bridge) — remaining gap is Deck-side UI only.

## What is built (2026-09-24, d99893d)

- **Engine attention is shared.** `src/domain/attention.ts` is the single source for `deriveAttention`/`parseLandabilityByName`/`nextBlockedNames`/`blockedSessionFromEvent`; `apps/cockpit/src/lib/attention.ts` re-exports it. Bridge and cockpit use the same badge priority.
- **Bridge module is real.** `src/deck/bridge.ts` `DeckBridge`: `connect()` over `ClientTransport` (unix socket, `wsTransport`, injected), `listWorktrees(workspaceId, { selectedId, landabilityByName, recentBlocked })` → `WorktreeCard { id, heading (= name), branch, worktreePath, status, colour, dot, selected }`, `attentionBySession`, `latestWords(tail)`, `resolveFilePath(worktreePath, projectRoot, rel)`, `land` passthrough, `onEvent`.
- **Entry point.** `src/deck/index.ts` re-exports the bridge — the module now HAS a call site beyond its test.
- **First real waiting signal.** `session.wait` / `session.unwait` RPCs (CONTROL) write `waiting` via `SessionRepo.updateStatus`; `deriveAttention(status === 'waiting') → needs_you` now fires for real, not only via `recentBlocked`. Gateway `ALLOWED_METHODS` + `CONTROL_METHODS` + cockpit `COCKPIT_CHANNELS` allowlisted.
- **Tests:** `tests/client/deck-bridge.test.ts` 5, `tests/domain/attention.test.ts` 8, `tests/daemon/methods-usage.test.ts` session.wait 2 — plus `typecheck` + `build` + in-memory transport pair.

## What is still missing, deliberately

- Deck repo itself was not touched — no extension/sidecar registers the bridge inside Deck, so `d99893d` is crossweave-side only.
- Worktree creation flow reuse / partial-checkout guard (Deck spec) is untouched.
- `land` from Deck has no Deck-side button/palette — `bridge.land` is wired but its caller is future Deck UI.
- `latestWords` is a string passthrough today — wiring it to `session.data` tail is the next step when session streaming is plumbed.
- `resolveFilePath` is a pure helper — Cmd+click still needs Deck's opener to call it.

## Gate

`bun run typecheck` · `bun test` (26+ tests incl. deck-bridge) · `bun run build` — Deck dev with 2 live sessions remains the future E2E gate.
