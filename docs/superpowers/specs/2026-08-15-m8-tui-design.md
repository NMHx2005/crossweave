# crossweave M8 — TUI Dashboard — Design Spec

**Date:** 2026-08-15
**Status:** Approved for planning
**Depends on:** M0–M7 (merged, `v0.1.0` released). Completes the original
design doc's V1 M6 scope (§4.12, §6) — the other half, Distribution, shipped
as M7.

---

## 1. Positioning

Every other milestone gave crossweave state; nothing shows it live. Today
"what's happening across my sessions" means running `cw session list`,
`cw converge status`, and reading desktop notifications as they arrive —
three separate, disconnected views, none of them live. M8 is one screen:
`cw tui`.

Per the original design doc §4.12: OpenTUI, square borders, neutral
palette with a single accent, short purposeful transitions. Panes: session
list with status and enforcement tier, live Radar feed, convergence
matrix, and a status bar carrying workspace, active sessions, disk, and
burn.

Decided during brainstorming (all three, each the more ambitious of two
options offered):

1. **Real push, not polling.** The daemon actively broadcasts events to
   the TUI as they happen — no fixed-interval refresh loop.
2. **Full interactivity from v1**, not a read-only dashboard: attach into
   a session, land, kill/stop, gc, and spawn a new session all happen
   without leaving the TUI.
3. Interactive actions in scope for v1: session new, land (single + all),
   kill/stop, gc, attach.

### Non-goals (V1)

- Not a general daemon-event bus for arbitrary future consumers — the
  broadcast mechanism (§3) is built for exactly what the TUI needs
  (§3.2's two message kinds), not a speculative pub/sub API.
- Not replacing the CLI. Every action the TUI exposes already exists as a
  `cw` subcommand; the TUI is a second, live-updating way to reach the
  same RPCs, not a new capability.
- Not remote/SSH access to the TUI in V1, despite OpenTUI itself
  supporting custom stdin/stdout streams for that — the daemon's own
  trust boundary (design doc §5.2: unix socket, OS-user-account scoped,
  no network listener) means a remote TUI would need its own transport
  story that's out of scope here.
- Not configurable layout/theming in V1 — one fixed 4-pane layout, one
  palette.

## 2. Architecture

```
 daemon (existing methods.ts + new broadcast.ts)
   │
   │  daemon.subscribe  (new RPC — no params)
   │◄──────────────────────────── cw tui process
   │                                   │
   │  tui.event {kind, ...}    ────────►  live Radar feed pane
   │  (full payload — same 4 kinds        (appends a line)
   │   notify() already carries)
   │
   │  tui.invalidate {}        ────────►  re-fetch session.list,
   │  (coarse signal, no payload)         converge.status, workspace.info
   │                                      → session list / matrix / status
   │                                        bar panes re-render
   │
   │  session.new / land.session / session.kill / session.stop /
   │  session.rm / workspace.gc   ◄──────  keymap actions (existing RPCs,
   │                                       unchanged)
   │
   └── on attach (Enter): renderer.suspend() → spawn `cw session attach
       <name>` as a child process, inherited stdio, await exit →
       renderer.resume()  (zero new PTY-relay code — reuses
       src/cli/commands/attach.ts exactly as-is)
```

Two new pieces (daemon-side broadcast registry, TUI process) plus keymap
wiring onto RPCs that already exist. The attach flow adds no new code
path at all — it shells out to the existing, already-tested command.

## 3. Daemon-side broadcast

### 3.1 `daemon.subscribe`

New RPC, no params. Registers the calling connection's `ctx.notify` into
a shared broadcast registry; `ctx.onClose` unregisters it. A TUI client
calls this once, right after connecting, before doing anything else.

`src/daemon/broadcast.ts` (new):

```typescript
export class BroadcastRegistry {
  private readonly subscribers = new Set<(method: string, params: unknown) => void>();

  subscribe(notify: (method: string, params: unknown) => void): () => void {
    this.subscribers.add(notify);
    return () => this.subscribers.delete(notify);
  }

  broadcast(method: string, params: unknown): void {
    for (const notify of this.subscribers) notify(method, params);
  }
}
```

Constructed once in `buildMethods`, alongside `notifyGate`/`notifyDeps` —
same lifecycle, same "one shared instance threaded to every call site"
pattern M6b established. `daemon.subscribe`'s handler:

```typescript
'daemon.subscribe': (_p, ctx) => {
  const unsubscribe = broadcastRegistry.subscribe(ctx.notify.bind(ctx));
  ctx.onClose(unsubscribe);
  return { subscribed: true };
},
```

### 3.2 Two broadcast message kinds — deliberately not a growing taxonomy

**`tui.event`** — the full payload of an M6b notify event (collision,
blocked, land, convergence — the same 4 kinds `notify()` already formats),
broadcast alongside (not instead of) the existing desktop-notification
send. Drives the live Radar feed pane directly: each one is a line
appended to that pane, using the exact same `format()` logic
`src/notify/dispatcher.ts` already has for the desktop notification's
title/message, so the feed's text and macOS's notification text never
drift apart.

**`tui.invalidate`** — no payload, fired after any RPC that changes
session/workspace state the TUI displays: `session.new`, `session.kill`,
`session.stop`, `session.rm`, `land.session` (in addition to its own
`tui.event`). The TUI's only reaction is to re-fetch `session.list`,
`converge.status`, and `workspace.info` and re-render. Deliberately coarse
rather than a granular typed event per mutation: a exhaustive taxonomy of
"what changed" events is more surface area to keep in sync with every
future RPC than "something changed, re-fetch the 3 things you show" — the
re-fetches are cheap, local SQLite reads, not worth optimizing away for a
dashboard nobody's driving faster than human reaction time.

This is a genuine push architecture (the TUI is idle, no timer, until an
event arrives) that avoids needing a second, separate design for "every
RPC handler must remember to emit its own typed event."

### 3.3 Wiring into existing call sites

`notify()` itself (`src/notify/dispatcher.ts`) is unchanged — its
contract (never throws, one shared function every trigger point calls
through) stays intact. A thin wrapper at the 5 existing call sites
(`radar.check`'s handler, `land.session`'s handler, the background
collision path, the ACP blocked path, `ConvergenceScheduler`) changes from
bare `notify(notifyDeps, event)` to also broadcasting:

```typescript
notify(notifyDeps, event);
broadcastRegistry.broadcast('tui.event', event);
```

`session.new`, `session.kill`, `session.stop`, `session.rm` gain one line
each, after their existing success path: `broadcastRegistry.broadcast('tui.invalidate', {})`.
`land.session`'s handler already fires `tui.event` via the wrapper above;
it also fires `tui.invalidate` (land changes what's mergeable, which the
convergence matrix pane shows) in the same success path.

### 3.4 Security

No new trust surface: `daemon.subscribe` is reachable by anyone who can
already open the daemon's unix socket, which design doc §5.2 already
scopes to the OS user account (`0600` socket, `0700` `.crossweave/`). A
subscriber sees exactly what a desktop notification or `cw session list`
already exposes — no new data crosses the boundary that wasn't already
readable via existing RPCs.

## 4. TUI process

New command `cw tui` (`src/cli/commands/tui.ts`), registered in
`src/cli/index.ts` alongside the other subcommands. Built on
`@opentui/core` directly (imperative `BoxRenderable`/`TextRenderable` API,
not the React or Solid bindings — matches this project's existing
zero-framework-dependency posture; `@opentui/core` becomes this project's
third runtime dependency after `citty`/`simple-git`/`web-tree-sitter`).

### 4.1 Layout — 4 panes, one fixed layout

```
┌─ crossweave — <workspace name> ──────────────────────────────┐
│ Sessions                    │ Convergence matrix              │
│ ● alice   running   T2      │        alice   bob    carol     │
│ ○ bob     idle      T1      │ alice    —     clean   ?         │
│ ● carol   running   T3      │ bob    clean    —    conflict    │
│                              │ carol     ?   conflict   —       │
├──────────────────────────────┴──────────────────────────────┤
│ Radar feed (live)                                              │
│ 12:03  collision  alice ↔ bob   src/x.ts#foo                   │
│ 12:01  land        carol → main  ok                            │
├────────────────────────────────────────────────────────────────┤
│ ws_1 · 3 sessions · disk 4.2G/20G · burn $1.24 · [n]ew [l]and  │
└────────────────────────────────────────────────────────────────┘
```

- **Session list**: name, a status dot (● running / ○ idle / ✕ ended),
  enforcement tier (T1/T2/T3). Selectable (arrow keys / j-k), selection
  drives which session `l`/`k`/Enter act on.
- **Convergence matrix**: pairwise grid from `converge.status`, `clean`/
  `conflict`/`?` (unknown) per cell — same semantics `cw converge status`
  already prints, just live and visual.
- **Radar feed**: scrolling log of `tui.event`s, newest at the bottom,
  using `format()`'s existing title/message text.
- **Status bar**: workspace name, session count, disk usage (from
  `workspace.info`), aggregate burn (`costSpentUsd` summed across
  `session.list`), and the active keymap hints.

### 4.2 Data flow

On startup: connect, call `daemon.subscribe`, then fetch `session.list`/
`converge.status`/`workspace.info` once to populate the initial view.
Thereafter: `tui.event` → append to the feed pane; `tui.invalidate` → re-run
those same 3 fetches and re-render the session list, matrix, and status
bar. No polling timer anywhere in this design.

### 4.3 Keymap

Via `@opentui/keymap` (same package family, confirmed available
alongside `@opentui/core`):

| Key | Action |
|---|---|
| ↑/↓ or j/k | move session selection |
| Enter | attach to selected session (§4.4) |
| n | new session — small inline form (name, agent kind), `session.new` |
| l | land selected session — `land.session` |
| L | land all — `land.session` looped in recommended order (mirrors `cw land all`'s existing CLI logic in `src/cli/commands/land.ts` — reuse that ordering function, don't reimplement) |
| k | kill selected session — `session.kill`, with an inline y/n confirm (matches design doc §5.4's destructive-op confirmation requirement) |
| g | gc — `workspace.gc`, with an inline y/n confirm (same §5.4 requirement) |
| q | quit |

### 4.4 Attach-in-place

```typescript
async function attachToSession(name: string, renderer: CliRenderer): Promise<void> {
  renderer.suspend(); // disables mouse, input, raw mode — full terminal control released
  try {
    const proc = Bun.spawn(['cw', 'session', 'attach', name], { stdio: ['inherit', 'inherit', 'inherit'] });
    await proc.exited; // returns when the user hits Ctrl-] (DETACH_KEY) inside attach.ts
  } finally {
    renderer.resume();
  }
}
```

Zero new relay code. `src/cli/commands/attach.ts` already handles raw
mode, the scrollback replay, `session.data`/`session.exit`, and the
`DETACH_KEY` (Ctrl-]) convention — the TUI just steps out of the way and
back in. The only new behavior is that the child process resolves `cw`
via `PATH` (or, more robustly, `process.execPath` + the running script's
own resolved entry — the implementer should verify which is correct
against how `bun build --compile` resolves this at task time, since a
compiled binary's argv[0] may not be a bare `cw` on `PATH`).

## 5. Testing

- `BroadcastRegistry` (§3.1): plain unit tests — subscribe, broadcast
  reaches all subscribers, unsubscribe stops delivery, multiple
  subscribers don't interfere. No network, no daemon needed.
- `daemon.subscribe` + broadcast wiring: integration tests at the
  `buildMethods` level, same pattern this project's existing
  `tests/daemon/methods-*.test.ts` files already use — call the RPC
  handler directly with a fake `ctx.notify` spy, assert it's called with
  the right method/params after triggering the relevant mutation. Covers
  all `tui.event` sites (the 5 existing `notify()` call sites) and all
  `tui.invalidate` sites (`session.new`, `session.kill`, `session.stop`,
  `session.rm`, and `land.session` — which fires both kinds, per §3.3).
- OpenTUI rendering itself is not unit-tested (matches this project's own
  precedent for `install.sh` — driving a real terminal isn't something
  `bun test` covers). A manual verification checklist (mirroring M7's
  smoke-test-checklist) covers: each pane renders real data, each keymap
  action fires the right RPC, attach/detach round-trips cleanly, and
  `renderer.suspend()`/`resume()` leaves the terminal in a sane state on
  both a clean detach and a killed child process.
- The land-all ordering reuse (§4.3) gets its own focused test if
  `src/cli/commands/land.ts`'s ordering logic isn't already exported as a
  standalone, directly-testable function — extracting it if needed is
  in-scope for that task, not a separate refactor.

## 6. Open questions for the plan to resolve

- Exact `@opentui/core`/`@opentui/keymap` version pins (a plan task should
  check current versions the same way M7's Task 8 verified GitHub Action
  versions — via the actual registry, not assumed).
- Terminal-resize handling (OpenTUI's docs note manual `renderer.resize`
  calls are needed with custom streams — `cw tui` uses the process's own
  real stdin/stdout, so this may be automatic; verify against real
  behavior during implementation rather than assuming).
- Whether the compiled `dist/cw` binary can correctly re-exec itself for
  the attach subprocess (§4.4's flagged risk) — verify early, since a
  wrong answer here changes the attach mechanism's design.
