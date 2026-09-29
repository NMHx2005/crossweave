# Plan — command bridge

Spec: `docs/superpowers/specs/2026-09-29-cockpit-command-bridge-design.md`
Branch: `feat/command-bridge`
Tier: Medium — a daemon module and three methods, a cockpit server, a CLI helper.

## Tasks

1. [x] **Registry (daemon, pure).** `src/daemon/bridge-registry.ts` with the rules of the spec
   (closed namespaces, first come first served, timeout clamp, caps, detach, exactly-once, only the
   addressee may respond); `tests/daemon/command-bridge.test.ts` (19 cases) written first.
2. [x] **Methods.** `bridge.register`, `bridge.respond`, `bridge.call` in `methods.ts`; a test over
   a real socket (`tests/daemon/methods-bridge.test.ts`) including the intruder and the detach.
3. [x] **Cockpit server.** `electron/command-bridge.ts` (`serve`, fail-closed `handle`);
   `DaemonBridge` registers on attach, answers `bridge.request` in main (never shown to the
   window) and tells the person when the slot is taken; a daemon without the bridge is not an error.
4. [x] **CLI helper.** `src/cli/bridge-call.ts` and `tests/cli/bridge.test.ts` (the one
   `CODE: message` line).
5. [x] **A kind to prove it.** `pane.ping`, served by the cockpit main process.
6. [x] **Gates + end to end.** Root typecheck/test/build, cockpit test/build, and
   `apps/cockpit/scripts/bridge-check.ts` against the running app.
7. [x] **Docs.** Known-limitations file and a digest line.

## Gate

`bun run typecheck` · `bun test --max-concurrency=1` · `bun run build` · cockpit `bun test` +
`bun run build` · the end-to-end script.
