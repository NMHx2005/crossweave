# M6b — Push notifications

## 1. Positioning

The roadmap's M6 (`docs/superpowers/specs/2026-08-09-crossweave-design.md` §6) bundles a TUI,
a budget/burn meter, and polish. M6a shipped the budget/burn backend independent of any
TUI (`docs/superpowers/specs/2026-08-13-m6a-budget-burn-design.md`). M6b is the second
independent piece: **push notifications**, so a user who has stepped away from the
terminal — or is watching a different session's `attach` — still learns about a
collision, a block, a landing, or a convergence-state change without polling.

M6b's own success criterion, independent of M6c's TUI: a user doing something else on
their Mac sees a native desktop notification the moment one of four events fires in any
crossweave-managed session, and can click it to jump straight to that session.

### Non-goals

- **Not cross-platform.** macOS only for v1 — `osascript` (built in) with an optional
  `terminal-notifier` upgrade for click-through. Linux/Windows are a future milestone if
  ever, not degraded-but-present here; §3.4 covers what a non-macOS host actually does
  (nothing, silently).
- **Not a new transport.** No webhook, no Slack/ntfy.sh integration, no internal
  pub/sub event stream for M6c to subscribe to. M6c's TUI, when it exists, polls the
  same RPCs the CLI already does — a live-update channel is that milestone's own
  problem if it turns out to need one, not something M6b builds speculatively for it.
- **Not a custom macOS app.** Every existing crossweave design doc restates the "zero
  native dependencies" principle (most recently `docs/superpowers/plans/2026-08-13-m5b-acp-client.md`'s
  Task 2 brief). Building and code-signing a Notification-Center-registered `.app` to
  get first-party click actions would violate that; `terminal-notifier` — a pre-signed,
  already-registered helper — gets click-through without crossweave shipping any native
  code of its own.
- **No per-turn or high-frequency events.** The four event types (§2) are already the
  ones that matter; this milestone does not add a fifth without a concrete need.

## 2. Trigger events

Four event types, each with an existing detection point already in the codebase — M6b
adds a notification *side effect* at each, not new detection logic:

| Event | Existing detection point | Fires when |
|---|---|---|
| `collision` | `src/radar/retro-notify.ts`'s `notifyCollisions` (background `fs.watch` path, called from `src/daemon/watcher.ts`'s `RadarWatcherRegistry`) and `src/daemon/methods.ts`'s `'radar.check'` RPC handler (live `PreToolUse` hook path — **not** `src/cli/commands/radar-hook.ts` itself, see §3.1 correction) | `NotificationGate.shouldNotify` returns `true` for a collision this daemon-persistent gate has not recently reported |
| `blocked` | `src/daemon/methods.ts`'s `'radar.check'` RPC handler (T2 hook path) and `src/adapters/acp.ts`'s `decideRequestPermission` (T1 in-process path) | `decideBlocked(...).blocked === true` at either call site |
| `land` | `src/daemon/methods.ts`'s `'land.session'` RPC handler | `landSession(...)` resolves (success) or rejects (failure) |
| `convergence` | `src/daemon/convergence-scheduler.ts`'s `tick()` | A trial with exactly 2 `branches` (`MergeTrialRow.result`, one of `'clean' \| 'conflict' \| 'test_fail' \| 'unverified'`) differs from that same sorted branch-pair's most recent prior trial in `MergeTrialRepo` — `ConvergenceScheduler` only has branch names natively (not session names); `sessionA`/`sessionB` in the event are resolved via `SessionRepo.listByWorkspace(...).find(s => s.branch === branchX)`, falling back to the raw branch name if no live session still owns it (the session could have been removed since the trial ran) |

## 3. Design

### 3.1 `NotifyDispatcher` — the one function every trigger point calls

Mirrors `decideBlocked` (`src/radar/decision.ts`, M5a/M5b) and `recordUsage`
(`src/domain/usage.ts`, M6a): one small piece of policy, called from every site that
needs it, so the policy — content formatting, throttling, click-target, degrade
behavior — is defined exactly once.

```ts
// src/notify/dispatcher.ts
export type NotifyEvent =
  | { kind: 'collision'; sessionA: string; sessionB: string; path: string; symbol: string | null; workspaceId: string }
  | { kind: 'blocked'; session: string; path: string; symbol: string | null; workspaceId: string }
  | { kind: 'land'; session: string; ok: true; baseBranch: string; workspaceId: string }
  | { kind: 'land'; session: string; ok: false; reason: string; workspaceId: string }
  | { kind: 'convergence'; sessionA: string; sessionB: string; from: MergeTrialResult; to: MergeTrialResult; workspaceId: string };

export interface NotifyDispatcherDeps {
  gate: NotificationGate; // the ONE instance buildMethods constructs and injects into RadarWatcherRegistry — see the correction below
  config: CrossweaveConfig;
  /** Injected so tests never spawn a real process — see §5. */
  send: (title: string, message: string, clickCommand: string[] | undefined) => void;
}

export function notify(deps: NotifyDispatcherDeps, event: NotifyEvent): void
```

`notify` is responsible for: checking `config.notify.enabled` and the per-event
`config.notify.events[kind]` flag (§3.3); formatting the title/message/click command
per §2's table; and calling `deps.send(...)`. It never throws — every failure inside
`notify` (a formatting bug, a `send` error) is caught and logged once, matching §3.5's
degrade posture, because a notification is observability, not a safety mechanism, the
same posture M6a's `recordUsage` already established for its own best-effort callers.

**Correction found while writing the implementation plan, before any code was
written:** the original draft of this section assumed `src/cli/commands/radar-hook.ts`'s
own module-level `NotificationGate` (used to throttle the hook's in-terminal advisory
text) was the same instance — or at least equivalent, cross-call-persistent — as
`RadarWatcherRegistry`'s. It is not. `radar-hook.ts`'s gate is constructed fresh **per
subprocess**: `cw radar-hook` is a brand-new process for every single `PreToolUse`
call (M3's own design doc states this explicitly: "Cross-process persistence is out of
scope for M3 — each `cw radar-hook` invocation is a fresh process, so this really only
coalesces within a single invocation's lifetime"). A gate that resets on every call
provides no real throttling at all — wiring the OS notification through it would fire
a desktop banner on very nearly every live-hook collision, defeating the whole point
of gating. The fix: the live-hook collision notification is **not** dispatched from
`radar-hook.ts`. It is dispatched from `src/daemon/methods.ts`'s `'radar.check'` RPC
handler instead — which already runs inside the long-lived daemon process, the same
process `RadarWatcherRegistry` lives in. `radar-hook.ts` itself is untouched by M6b:
it keeps computing and returning `blocked`/`collisions` exactly as it does today, with
its own ephemeral gate governing only its own advisory-text throttling, unrelated to
and unaffected by M6b.

To make `radar.check` and the background watcher share ONE real gate (not two
separate persistent-but-distinct ones, which would let the same collision double-fire
a banner if both paths noticed it near-simultaneously), `RadarWatcherRegistry` gains an
injected `gate` constructor parameter instead of constructing its own
(`private readonly gate = new NotificationGate();` today) — `buildMethods` constructs
one `NotificationGate` and passes it both into `new RadarWatcherRegistry(db, bus,
contracts, gate)` and into every `NotifyDispatcherDeps` it builds for the other three
event types. The parameter defaults to `new NotificationGate()` so every existing
`RadarWatcherRegistry` test that constructs it without a fourth argument keeps working
unchanged.

**Gating is asymmetric by design, not uniform inside `notify`:**

- **`collision` via the background watcher path** does NOT gate a second time inside
  `notify`. `notifyCollisions` (`retro-notify.ts`) already calls
  `gate.shouldNotify(sessionId, path, symbol)` once, today, against
  `RadarWatcherRegistry`'s own persistent gate, to decide whether to send the
  system-trust advisory message at all — `notify(deps, { kind: 'collision', ... })` is
  only ever called from inside that `if (shouldNotify)` branch, piggybacking on a
  decision already made against a real persistent gate, at zero extra cost.
- **`collision` via the live hook path** gates inside `notify` itself, because there is
  no persistent caller-side check to piggyback on (see the correction above) —
  `'radar.check'`'s handler calls `notify(deps, { kind: 'collision', ... })` for every
  collision `decideBlocked`/`checkCollisions` reports, and `notify` consults the SAME
  gate instance the background watcher path uses (see below), with the same
  `(sessionId, path, symbol)` key shape — so a collision the background watcher already
  reported recently does not also fire a second banner the moment a live hook call
  happens to see it too, and vice versa.
- **`blocked`, `land`, `convergence`** have no existing caller-side gate check to
  piggyback on either, so `notify` consults that same shared gate, with its own key,
  under a namespace that can never collide with `collision`'s
  `(sessionId, path, symbol)` keys:
  - `blocked`: `(session, path, symbol)` — identical shape, reused directly. A session
    blocked repeatedly on the exact same path/symbol coalesces like a collision would;
    blocked on a different path is a new notification.
  - `land`: `(session, '__land__', null)` — one notification per session per land
    attempt is exactly what "coalesce within the gate's window" already means here; a
    session that lands, fails, and is re-landed within the window is intentionally
    throttled the same way a noisy collision would be.
  - `convergence`: `(sortedPair, '__convergence__', null)` where `sortedPair` is the
    two session names joined and sorted, so `(A,B)` and `(B,A)` share one throttle
    bucket. `'__land__'`/`'__convergence__'` are not valid file paths, so they can
    never collide with a real Radar `(sessionId, path, symbol)` key by coincidence.

### 3.2 Sending: `terminal-notifier` if present, `osascript` fallback

```ts
// src/notify/macos.ts
let terminalNotifierPath: string | undefined | null = null; // null = not yet checked

function resolveTerminalNotifier(): string | undefined {
  if (terminalNotifierPath !== null) return terminalNotifierPath ?? undefined;
  try {
    terminalNotifierPath = execFileSync('which', ['terminal-notifier'], { encoding: 'utf8' }).trim();
  } catch {
    terminalNotifierPath = undefined;
  }
  return terminalNotifierPath ?? undefined;
}

export function sendMacNotification(title: string, message: string, clickCommand: string[] | undefined): void
```

Resolved once per daemon process (module-level cache, invalidated only by a daemon
restart — matches `starting`/`triedPairs`' existing process-lifetime-state precedent
elsewhere in the daemon) rather than shelling out to `which` on every notification.

- **`terminal-notifier` present, `clickCommand` given:** `terminal-notifier -title
  <title> -message <message> -execute <shell-command>`, where `<shell-command>` opens
  Terminal.app running `clickCommand` — built as `osascript -e 'tell application
  "Terminal" to do script "..."' -e 'tell application "Terminal" to activate'`, itself
  invoked via `execFileSync` with an **argv array**, never a concatenated shell string
  (CLAUDE.md §5; matches every other subprocess call in this codebase —
  `checkCollisions`, `git` invocations throughout `src/isolation/`, etc.). `path`/
  `symbol` values from Radar can contain arbitrary characters and are never safe to
  inline into an AppleScript string literal or a shell command; each of `title`,
  `message`, and every element of `clickCommand` is passed as its own argv element,
  and `do script`'s payload is passed through `osascript`'s own `-e` mechanism with the
  actual command text kept out of AppleScript string interpolation by building the
  `do script` argument as a single properly-`JSON.stringify`-quoted AppleScript string
  literal — full quoting mechanics are a plan-level, not spec-level, decision.
- **`terminal-notifier` present, no `clickCommand`** (not currently used by any of the
  4 events, but kept for interface completeness): passive banner via
  `terminal-notifier -title ... -message ...`, no `-execute`.
- **`terminal-notifier` absent:** `osascript -e 'display notification "<message>" with
  title "<title>"'`, passive only — `display notification` has no click-action
  mechanism (§0 research finding, stated directly in chat during brainstorming and
  restated here for the record). Same argv-array-only construction rule applies.

### 3.3 Config

```ts
// src/core/config.ts — CrossweaveConfig gains:
notify: {
  enabled: boolean;
  events: { collision: boolean; blocked: boolean; land: boolean; convergence: boolean };
};
```

`DEFAULT_CONFIG.notify` is `{ enabled: true, events: { collision: true, blocked: true,
land: true, convergence: true } }` — on by default, matching M6a's own "the user sees
value immediately, opts out if it's noise" posture. A config file missing the `notify`
key entirely (every workspace's `crossweave.config.json` predating M6b) merges against
this default the same way every other `CrossweaveConfig` sub-object already does.

`cw config notify on|off [--event collision|blocked|land|convergence]` — omitting
`--event` sets the master `enabled` switch; with `--event`, sets that one key in
`events` without touching `enabled` or the other three. Mirrors `cw workspace
safe-mode <tier>`'s existing shape (a subcommand that reads current state with no args,
sets it with one). Writes through to the on-disk `crossweave.config.json`, the same
file `loadConfig`/`DEFAULT_CONFIG` already read/merge — exact read-modify-write
mechanics are a plan-level decision (whether a config-writing helper already exists
elsewhere in this codebase for `cw config trust`/`untrust` to reuse, or this is new).

### 3.4 Platform detection

`sendMacNotification` (and therefore `notify`) is only ever wired in when
`process.platform === 'darwin'`; `buildMethods`/the daemon's own construction on any
other platform wires in a no-op `send` that never fires and never logs — not a
degrade path with a warning, a deliberate silent absence, because a Linux/Windows host
was never told this milestone supports it (§1 non-goals).

### 3.5 Failure posture

Any failure inside `notify` or `sendMacNotification` — `osascript`/`terminal-notifier`
exiting non-zero, throwing, or (on a headless macOS host, e.g. over SSH with no logged-in
GUI session) failing to reach Notification Center at all — is caught, logged **once**
per daemon process lifetime (a module-level flag, not per-failure), and never
propagates. Matches every other best-effort path this project has shipped: M6a's
`recordUsage` callers, `cw radar-hook`'s own "never block the agent" contract. A
notification failing must never fail the RPC it's attached to (`land.session` still
returns its real result to the caller even if the accompanying notification failed to
send) or crash the daemon.

## 4. Data flow

```
Radar collision, background fs.watch path (RadarWatcherRegistry -> notifyCollisions)
  -> gate.shouldNotify(sessionId, path, symbol) === true   [existing call, unchanged]
  -> (system-trust advisory message sends, as it already does today)
  -> notify(deps, { kind: 'collision', ... })              [no 2nd gate check — piggybacks]
  -> config check -> sendMacNotification(...)

Radar collision, live PreToolUse hook path (radar-hook.ts -> radar.check RPC)
  -> radar.check's handler computes collisions via decideBlocked/checkCollisions
     (radar-hook.ts's own advisory-text response is unchanged, unaffected by M6b)
  -> for each collision: notify(deps, { kind: 'collision', ... })
  -> config check -> gate.shouldNotify(sessionId, path, symbol) [SAME gate instance
     RadarWatcherRegistry uses] -> sendMacNotification(...)

Write blocked (radar.check RPC OR AcpAdapter.decideRequestPermission)
  -> decideBlocked(...).blocked === true
  -> notify(deps, { kind: 'blocked', ... })
  -> config check -> gate.shouldNotify(session, path, symbol) -> sendMacNotification(...)

land.session RPC resolves/rejects
  -> notify(deps, { kind: 'land', ok: true|false, ... })
  -> config check -> gate.shouldNotify(session, '__land__', null) -> sendMacNotification(...)

ConvergenceScheduler.tick() records a new MergeTrialRepo row
  -> compare against that pair's most recent prior trial
  -> differs -> notify(deps, { kind: 'convergence', from, to, ... })
  -> config check -> gate.shouldNotify(sortedPair, '__convergence__', null) -> sendMacNotification(...)
```

## 5. Testing

- `notify()`: unit tests against an injected `send` spy and a real (or seeded)
  `NotificationGate` — one test per event `kind` asserting title/message/click-command
  content; a config-disabled test (master off, and per-event off) asserting `send` is
  never called; a throttle test reusing `NotificationGate`'s own existing test
  patterns (`tests/radar/noise.test.ts`) proving the gate is actually consulted, not
  bypassed.
- `sendMacNotification`: **not** unit-tested by actually spawning `osascript`/
  `terminal-notifier` and observing a real banner — matches this project's own stated
  precedent for OS-boundary code (`ClaudePtyAdapter`'s PTY spawn, `RadarWatcherRegistry`'s
  `fs.watch`, both explicitly "deliberately NOT unit-tested against the live OS
  mechanism, see this file's own doc comment"). Argv construction (no string
  interpolation into a shell/AppleScript command) is tested by asserting on the argv
  array a fake `execFileSync` receives, not by execution.
- Platform gating (§3.4): a test asserting the daemon wires a no-op `send` when
  `process.platform !== 'darwin'`, via whatever seam the implementation plan chooses to
  make `process.platform` overridable in a test (this project's established idiom
  elsewhere, e.g. `clock` injected into `NotificationGate` itself, is to inject rather
  than monkey-patch a global).
- CLI: `cw config notify on/off` round-trips through a real `crossweave.config.json`,
  matching the existing `tests/cli/cli.test.ts` end-to-end pattern.

## 6. Known limitations (recorded honestly at implementation time, not deferred silently)

- **macOS only.** No degrade-with-a-warning on Linux/Windows — the feature is simply
  absent there (§3.4), stated plainly rather than implied to work everywhere.
- **Click-through requires `terminal-notifier`**, an optional external dependency not
  bundled with crossweave. Without it, notifications are informational-only banners.
- **Click-through always opens Terminal.app**, never the user's actual preferred
  terminal (iTerm2, kitty, Ghostty, etc.) if different — a real, known gap, not solved
  by this milestone (§0 research finding from brainstorming).
- **No GUI session (headless/SSH) means notifications silently never arrive** — logged
  once, not surfaced anywhere else; a user running crossweave over SSH with no
  logged-in local GUI session gets no signal that notifications are configured but
  inert.
- **`land`/`convergence` throttle coalesces per session (or per pair), not per
  distinct outcome** — a session that lands successfully, is re-landed, and fails
  within the same 10-minute gate window only gets the first notification, not a
  correction. Acceptable for an at-a-glance signal, not a precise log (the real log is
  `cw blame`/the event ledger, unaffected by this milestone).

## 7. Out of scope / deferred

- Cross-platform support (Linux `notify-send`, Windows toast notifications).
- Any new transport: webhook, Slack, ntfy.sh, email.
- An internal daemon pub/sub event stream for M6c's TUI to subscribe to live — M6c's
  own problem if it turns out to need one.
- Per-workspace (vs. global) config — `notify` lives in the same `crossweave.config.json`
  every other per-workspace setting already does, no new scoping mechanism.
- Notification history / a `cw notify log` command to review past notifications —
  the event ledger (`cw blame`) already covers forensics; this milestone's
  notifications are ephemeral, at-a-glance signals only.
