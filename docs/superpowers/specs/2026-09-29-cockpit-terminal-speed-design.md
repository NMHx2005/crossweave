# Cockpit terminal speed — a GPU renderer and fewer messages

**Date:** 2026-09-29
**Status:** Planned
**Scope:** `apps/cockpit` (renderer + deps), `src/daemon/runtime.ts`,
`src/daemon/terminals.ts`, one new daemon module, benchmark scripts.
**Branch:** `feat/cockpit-speed`

## Problem

The cockpit's panes render in xterm.js's **default DOM renderer**: only
`@xterm/addon-fit`, `@xterm/addon-search` and `@xterm/addon-unicode11` are loaded
(`apps/cockpit/src/ui/XtermPane.tsx:57`). There is no GPU renderer. Ghostty, the bar the
user compares against, is a native (Zig) emulator drawing through Metal.

Two further costs sit on the data path before a byte reaches xterm:

- The daemon forwards **one `session.data` / `terminal.data` notification per pty chunk**
  (`src/daemon/runtime.ts:93-98`, `src/daemon/terminals.ts:66-70`). A burst becomes
  hundreds of JSON-RPC lines over the unix socket, then hundreds of Electron IPC messages,
  then hundreds of `term.write` calls.
- Nothing coalesces them, at either hop.

This is not a claim that the cockpit can equal Ghostty — it is a dedicated native
emulator. The goal is to remove the avoidable gap and then **measure** the remainder.

## Goals / non-goals

**Goals**
- A GPU renderer for the panes a person is looking at, without exhausting the browser's
  WebGL contexts and without thrashing renderers on tab switches.
- Output coalescing that cuts message count by a large factor while leaving interactive
  echo latency unchanged.
- A repeatable benchmark that reports numbers before and after, stage by stage.

**Non-goals**
- Replacing Electron or writing a native emulator.
- Ligatures/text shaping (an xterm.js limitation).
- **Flow control / backpressure.** `term.write` has none; coalescing is not one. A slow
  renderer under a firehose stays a separate, documented gap.
- Rendering parity with Ghostty. The honest target is "no longer feels slow; the
  remaining gap is documented".

## 1. The GPU renderer

**Dependency.** `@xterm/addon-webgl@0.19.0`. Verified 2026-09-29: the published tarball
contains only `.js/.mjs/.map/.d.ts/.ts`, **no `.node`**, `dependencies: none`,
`peerDependencies: none`, and no `install`/`postinstall` script (only `build`/`package`/
`prepublishOnly`). It clears the repository's "zero native modules" rule. Confirm once
more inside `apps/cockpit` after `bun install` (the addon throws if the xterm API
mismatches), and smoke a pane in the running app.

**The real constraint: contexts.** Chromium caps live WebGL contexts (~16). The cockpit
keeps **every tab mounted** (inactive ones `hidden` — `apps/cockpit/src/lib/layout.ts:380`,
`apps/cockpit/src/ui/Stage.tsx:404`) and up to six project views live
(`apps/cockpit/src/lib/mounted-views.ts`).

**Design — a renderer coordinator.** New module
`apps/cockpit/src/lib/terminal-renderer.ts`, an acquire/release registry:

- `acquire(paneKey)` — a WebGL addon for a pane that is *actually visible* (its tab
  shown, its view shown, container non-zero).
- **Hidden panes keep their context.** Evicting them would rebuild the texture atlas on
  every tab switch — tens of ms per pane, visible under the motion phase's cross-fade.
  The budget is the limit, not visibility.
- A **budget** below the browser cap (start at **12**, leaving headroom under ~16) with
  **LRU eviction** only when the budget is exceeded. Visible panes are never evicted
  before hidden ones; a pane evicted while visible falls back to DOM and must still paint
  the full viewport from the terminal's own buffer (tested).
- `webglcontextlost` → dispose immediately (DOM fallback, log once). On re-show /
  `webglcontextrestored` → re-acquire if within budget.
- No WebGL2 → stay DOM, never throw.

`XtermPane` (`XtermPane.tsx`) is the only caller. It acquires after `term.open(container)`
and releases before `term.dispose()`. The budget/eviction/visibility decisions are plain
functions over a fake addon factory and unit-test without a GPU; the GPU path is exercised
by the benchmark in the running app.

## 2. Output coalescing

**Design — per-subscriber buffers in the daemon.** New module
`src/daemon/output-coalescer.ts`, used by `SessionRuntime` and `TerminalRegistry`:

- Each subscriber has its **own buffer**. `onData` appends to every subscriber's buffer;
  the entry's `scrollback` is still updated synchronously, as today.
- **Leading-edge flush:** if nothing is pending and the last flush was more than the
  window ago (start 4 ms), send immediately; otherwise flush on the timer. Idle echo
  pays **zero** added latency; only bursts coalesce.
- Flush early when a buffer exceeds a cap (256 KB).
- **Flush on `exit`** so the final output always reaches subscribers.
- **On subscribe, clear that subscriber's pending buffer first.** `subscribe()` lets the
  **same ctx attach again** (`runtime.ts:145-156`: it is already in `subscribers`, so it is
  not added again, but it still replays). If that ctx had a pending chunk C, the replay
  (which already contains C in the scrollback) would be followed by the timer flush of C —
  a duplicate, and the cockpit calls `attach` every time a pane remounts. So on every
  subscribe — **new or re-attach** — cancel the ctx's timer and drop its buffer, **then**
  replay the scrollback. The replay is the bounded scrollback (the existing attach
  contract), so nothing a subscriber would otherwise have received is lost.
- **A closing subscriber's buffer is dropped**, not flushed — there is no one to deliver
  to; `onClose` already removes the subscriber.
- `resize` does **not** flush: it is client→daemon and emits no notification
  (`runtime.ts:132-138`).
- Order is preserved exactly; payload shape is unchanged, so every client (CLI, TUI,
  cockpit, future iOS) benefits with no wire change. The daemon's own `observer.output`
  (`session-status`) is untouched.

**Why the daemon, not the Electron bridge.** The daemon is the single choke point; a
bridge would fix one client. **Why not touch the input path.** Only daemon→client
*output* is buffered; keystrokes go straight to the pty.

**Not a backpressure mechanism.** Under a firehose the bottleneck may be xterm's parser,
not IPC; `term.write` queues without limit. Coalescing reduces message overhead only.

## 3. Benchmark

`apps/cockpit/scripts/bench-terminal.ts` (same shape as
`apps/cockpit/scripts/fidelity-resize.ts`: app already open, CDP on `COCKPIT_DEBUG_PORT`),
plus a daemon unit test for the coalescer.

Measure **three stages separately** so each change's effect is visible:
1. baseline (`main`), 2. `+coalesce`, 3. `+WebGL`.

Per stage: wall time to last line, number of `session.data` notifications, bytes,
`term.buffer.active.length`, and interactive echo round-trip. If the firehose is dominated
by xterm parsing rather than IPC, say so — that is the honest result.

## Testing

- `tests/daemon/output-coalescer.test.ts` — order preserved; leading-edge immediate when
  idle; coalesce within a burst; early flush at the cap; flush on exit; **new-subscriber
  race: a pending chunk is delivered exactly once**; **re-attach race: the same ctx
  attaching again with a pending chunk does not receive it twice**; closing subscriber
  drops its buffer.
- `apps/cockpit/tests/terminal-renderer.test.ts` — budget respected; LRU evicts hidden
  before visible; hidden panes keep contexts until the budget; a pane evicted while
  visible still paints from buffer; context-lost disposes and DOM fallback holds; no-WebGL
  stays DOM.
- Benchmark script run by hand (and by CI on a machine with a screen).

## Risks

- **Context exhaustion** if the budget is mis-set — budget + LRU eviction, visible-first.
- **GPU process disabled / driver differences** — hardware acceleration is on by default
  (`apps/cockpit/electron/main.ts` sets no `disableHardwareAcceleration`); failure → DOM.
- **Coalescing latency** — leading-edge keeps idle echo at zero added delay; pinned by the
  benchmark's echo measurement.

## Review revisions (2026-09-29)

Round 1: per-subscriber buffers (was contradictory); leading-edge flush; hidden panes keep
contexts, budget 12; three-stage benchmark; the no-backpressure gap named. Claim #1 (addon
purity) verified from the npm tarball.

Round 2: the subscribe race also covers **the same ctx re-attaching**, so its pending
buffer is cleared (timer cancelled) before replay — otherwise a live pane that remounts
would double-print a chunk (the cockpit calls `attach` on every remount).

## Known limitations (to write at merge)

- The cockpit still does not match a native GPU emulator on raw throughput; the benchmark
  records where it stands.
- Ligatures/shaping are not supported.
- No flow control: a renderer slower than the firehose queues in `term.write`.
- Beyond the context budget, panes run DOM.
