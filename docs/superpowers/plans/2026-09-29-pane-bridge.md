# Plan — pane bridge

Spec: `docs/superpowers/specs/2026-09-29-cockpit-pane-bridge-design.md`
Branch: `feat/pane-bridge`
Tier: Medium/Large — a pure request handler, a main↔renderer round trip, the view wiring, a CLI, a security-shaped
test matrix.

## Tasks

1. [x] **Request handler (pure).** `apps/cockpit/src/lib/pane-bridge.ts`: `runPaneRequest(stage, request, ask)` returns
   the new stage and the answer; each kind, strict validation, the confirmation matrix, the pane cap, toasts.
   `apps/cockpit/tests/pane-bridge.test.ts` first.
2. [x] **Round trip in main.** `electron/renderer-bridge.ts` (pending map keyed by a main-made id, answered once, 50 s
   timeout, `BRIDGE_NO_WINDOW`), the `cockpit.bridge` event and the `bridge.reply` channel, the `pane.*` kinds
   served through `commandBridge`. Tests.
3. [x] **Renderer.** `App` routes a request to the project's `ProjectView`; the view runs `runPaneRequest` against
   its stage with `host.askConfirm` and shows the toast; replies through `bridge.reply`.
4. [x] **CLI.** `cw pane …` (`src/cli/commands/pane.ts`), `tests/cli/pane.test.ts`.
5. [x] **End to end** on the running app with `scripts/pane-check.ts`, including the refusals.
6. [x] **Docs.** Known-limitations file and a digest line.

## Gate

`bun run typecheck` · `bun test --max-concurrency=1` · `bun run build` · cockpit `bun test` + `bun run build` · the
end-to-end script.

## Report

The security matrix (which kinds ask, which only toast) and what an unconfirmed request does, before the next phase.
