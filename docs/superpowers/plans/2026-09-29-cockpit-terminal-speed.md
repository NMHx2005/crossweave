# Plan — cockpit terminal speed

Spec: `docs/superpowers/specs/2026-09-29-cockpit-terminal-speed-design.md`
Branch: `feat/cockpit-speed`
Tier: Medium — one dependency, one new renderer module, one new daemon module, scripts.

## Tasks

1. [x] **Dependency.** Add `@xterm/addon-webgl@0.19.0` to `apps/cockpit/package.json`.
   Purity already verified from the npm tarball (no `.node`, no deps, no
   `install`/`postinstall`); re-confirm after `bun install` and smoke one pane in the
   running app.
2. [x] **Renderer coordinator (pure core + tests).**
   `apps/cockpit/src/lib/terminal-renderer.ts`: acquire/release, budget (12), LRU
   eviction, hidden panes keep contexts until the budget, context-lost → DOM fallback,
   no-WebGL stays DOM. Unit tests over a fake addon factory, including "a pane evicted
   while visible still paints the full viewport" (`apps/cockpit/tests/
   terminal-renderer.test.ts`).
3. [x] **Wire XtermPane.** Acquire after `term.open(container)` using the existing
   `shown`/`focused` signals and the zero-size guard (`XtermPane.tsx:112`); release before
   `term.dispose()`; handle `webglcontextlost`.
4. [x] **Output coalescer (daemon, pure core + tests).**
   `src/daemon/output-coalescer.ts`: **per-subscriber** buffers, leading-edge flush when
   idle, coalesce within a burst, cap flush (256 KB), flush on exit, drop on subscriber
   close, and **clear-on-subscribe** (cancel the ctx's timer and drop its buffer before
   replay, for a new *or* re-attaching ctx). Tests: order, leading edge, cap/exit,
   **new-subscriber race**, and **re-attach race** (the same ctx with a pending chunk must
   not double-print) (`tests/daemon/output-coalescer.test.ts`).
5. [x] **Wire the coalescer** into `SessionRuntime` (`runtime.ts:93`) and
   `TerminalRegistry` (`terminals.ts:66`), leaving `scrollback` synchronous and the
   `subscribe()` replay path behaviour unchanged apart from the buffer clear.
6. [x] **Benchmark.** `apps/cockpit/scripts/bench-terminal.ts` (CDP, modelled on
   `fidelity-resize.ts`): flood the pane; measure notifications, time to last line, bytes,
   echo round-trip. Record **baseline, +coalesce, +WebGL** separately.
7. [x] **Gates + honest numbers.** Root `bun run typecheck`, `bun test
   --max-concurrency=1`, `bun run build`; cockpit `bun test`, `bun run build`; run the
   benchmark and paste the three-stage table.
8. [x] **Docs.** Known-limitations file + digest line; note the measured numbers, the
   remaining gap vs a native emulator, and that coalescing is not backpressure.

## Gate

`bun run typecheck` · `bun test --max-concurrency=1` · `bun run build` · cockpit
`bun test` + `bun run build` · benchmark reported.

## Report before next phase

Paste the three-stage benchmark and the context behaviour before starting the
tmux-parity phase.
