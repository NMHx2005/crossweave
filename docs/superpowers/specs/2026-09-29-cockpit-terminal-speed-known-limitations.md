# Cockpit terminal speed — known limitations

**Date:** 2026-09-29 · Design: `2026-09-29-cockpit-terminal-speed-design.md` · Branch `feat/cockpit-speed`

## What shipped

- The daemon coalesces `session.data` / `terminal.data` per subscriber
  (`src/daemon/output-coalescer.ts`): leading-edge send, 4 ms window, 256 KB cap, flush
  before exit, buffer cleared on every subscribe.
- Panes draw with `@xterm/addon-webgl` through a context budget of 12
  (`apps/cockpit/src/lib/terminal-renderer.ts`).
- `apps/cockpit/scripts/bench-terminal.ts` measures a flood, frames and echo.

## Measured (flood `seq 1 1000000`, 7.9 MB, one pane, an isolated daemon and profile)

| Stage | notifications | to last line | main-thread busy | frames >33 ms | echo p50 / p95 |
|---|---|---|---|---|---|
| baseline (`main`) | 48 974 | 832 ms | 0.55 s | not measured | 1.9 / 5.1 ms |
| + coalesce | 224 | 905 ms | 0.30 s | not measured | 1.8 / 4.5 ms |
| + coalesce, DOM renderer (re-run) | 230 | 935 ms | 0.37 s | 0 of 135 | 2.2 / 3.1 ms |
| + WebGL | 226 | 916 ms | 0.31 s | 0 of 132 | 1.9 / 3.7 ms |

Coalescing is the big win: about 200x fewer messages and roughly 40% less main-thread work,
with echo latency unchanged. WebGL saves about 0.06 s of main-thread time on this flood and
dropped no frames either way, so on a single small pane the two renderers are
indistinguishable here. Time to last line did not improve: it is bound by the shell and the
pty, not by delivery. Single runs on one machine with a 100 Hz display — indicative, not a
statistical claim; the baseline row predates the frame probe.

## Limitations

- **Not a native emulator.** The cockpit does not match Ghostty on raw throughput, and
  ligatures / text shaping are not supported (an xterm.js limit).
- **No flow control.** Coalescing trims message overhead; it is not backpressure.
  `term.write` still queues without bound under a firehose.
- **Beyond the context budget, panes run DOM.** Twelve contexts are shared by all mounted
  tabs of up to six projects. Hidden panes keep theirs until the budget forces an eviction.
- **A pane that lost its context re-acquires on its next resize/visibility signal**, not
  the instant the context returns (`webglcontextrestored` is not listened for), and the
  loss is not logged.
- **The benchmark does not measure GPU-side cost** (it lives in the GPU process); it reports
  main-thread time and frame deltas. A wide window, many panes, or heavy scrolling are where
  WebGL is expected to matter and were not measured.
- **Visibility is inferred from the container size** (a hidden tab measures 0x0), the same
  signal `applyFit` uses, and updates when the `ResizeObserver` fires.
