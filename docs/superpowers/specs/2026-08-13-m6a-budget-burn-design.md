# M6a — Budget/burn backend

## 1. Positioning

The roadmap's M6 (`docs/superpowers/specs/2026-08-09-crossweave-design.md` §6) bundles three
things: an OpenTUI dashboard, a budget/burn meter, and general polish. Investigating the
budget/burn meter found it is not "a UI panel over an existing backend" — `token_budget`/
`token_spent` exist only as schema columns, written once at session creation (`tokenSpent: 0`)
and never touched again. §4.11's "per-session token and cost accounting from adapter-reported
usage" has no implementation at all.

**M6a is that backend, independent of any TUI.** Its own success criterion is `cw session
list` showing real, live spend — a TUI (M6c) can render the same numbers richer later, but
M6a must be independently useful and independently testable without one. Live push
notifications for a Radar feed and a convergence matrix (M6b) are a separate, unrelated gap,
tracked in its own design.

### Non-goals

- No auto-pause on budget overrun. The design spec's "paused, not killed, and the user is
  prompted" needs a UI to prompt through — M6a ships the accounting and a CLI warning only;
  auto-pause is M6c's job once there's a TUI to prompt in.
- No OpenTUI, no live-updating display of any kind — `cw session list` (one-shot CLI output)
  is the only surface this milestone touches.
- No per-turn usage granularity. Both data sources this design uses are cumulative
  session-level totals (§2); a per-turn breakdown is not available from either without
  materially more invasive integration (parsing Claude Code's undocumented transcript JSONL,
  or waiting on ACP's still-draft End-Turn Token Usage RFD) and is not required for a budget
  meter, which only needs "how much so far."

## 2. Research findings that shape this design

- **Claude Code (T2, PTY)**: the `statusLine` mechanism is configured through the exact same
  `--settings` JSON crossweave already injects for the `PreToolUse` hook (`radarHookSettings()`
  in `src/adapters/claude-pty.ts`) — no new flag, no new spawn-time surface. Claude Code
  invokes the configured command after every assistant message (debounced 300ms) with a JSON
  payload on **stdin**:
  ```json
  { "cost": { "total_cost_usd": 0.01234, ... },
    "context_window": { "total_input_tokens": 15500, "total_output_tokens": 1200, ... } }
  ```
  and renders whatever the command prints to **stdout** as the terminal's status line. Both
  `cost.total_cost_usd` and the context-window token counts are cumulative for the session,
  not deltas.
- **ACP (T1)**: `session/update` has a `usage_update` variant, native to the protocol schema —
  `UsageUpdate { used: uint64, size: uint64, cost?: { amount: number, currency: string } }`.
  `used`/`size` are context-window tokens (used vs. total). Per the SDK's own schema,
  `used` is "tokens currently in context" — context-window OCCUPANCY, not a cumulative
  running total: it can DECREASE after a compaction, unlike Claude Code's statusLine
  path, which reports a genuinely monotonic total. crossweave stores both into the same
  `session.token_spent` column regardless (§3.2), so that column means a different
  thing depending on which adapter reported it — documented as a known limitation
  (`docs/superpowers/specs/2026-08-13-m6a-known-limitations.md`), not silently implied
  to be consistent. `cost.amount`, by contrast, genuinely IS "cumulative session cost"
  per the same schema — only the token half of ACP's report is the wrong kind of
  number, not the cost half. `cost`'s `currency` field is also required by the schema
  and must be checked before trusting `amount` as USD (§3.2's `recordUsage` caller in
  `src/adapters/acp.ts` only records cost when `currency` is `'USD'`, case-insensitive
  — a non-USD report is skipped exactly like an absent `cost` field already is).
  `PromptResponse` itself carries no usage field — `usage_update` is the only source.
- **Neither source is authoritative billing data.** Anthropic's own docs state this explicitly
  for both the statusLine payload and the SDK's cost fields ("client-side estimates... do not
  bill end users or trigger financial decisions from these fields"). M6a's `cost_spent_usd` is
  therefore an estimate for the user's own budgeting, not an accounting record — this must be
  stated plainly wherever the number is shown, not implied to be precise.

## 3. Design

### 3.1 Schema v8 — cost columns alongside the existing token columns

```sql
ALTER TABLE session ADD COLUMN cost_spent_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE session ADD COLUMN cost_budget_usd REAL;
```

Both budgets are independent and optional — a session can have a token budget, a cost budget,
both, or neither. `SessionRow` gains `costSpentUsd: number` and `costBudgetUsd: number | null`,
mirroring `tokenSpent`/`tokenBudget` exactly.

### 3.2 `recordUsage` — the shared function both adapters report through

Mirrors `decideBlocked`'s established shape (M5a/M5b): one plain function, two callers, one in
`radar/decision.ts`-style isolation:

```ts
// src/domain/usage.ts
export interface RecordUsageParams {
  sessionId: string;
  tokensUsed?: number;   // cumulative, not a delta
  costUsd?: number;      // cumulative, not a delta
}
export function recordUsage(deps: { sessions: SessionRepo }, params: RecordUsageParams): void
```

`SessionRepo` gains `updateUsage(id, { tokensSpent?, costSpentUsd? })`, a plain `UPDATE`
setting whichever fields were provided — matching `updateStatus`'s existing style. Two callers:

1. **`session.reportUsage` RPC** (new, in `src/daemon/methods.ts`) — calls `recordUsage`
   directly. Used by the new `cw session-usage-hook` CLI subcommand (§3.3), a separate
   subprocess, so it needs the RPC round-trip the same way `cw radar-hook` needs one for
   `radar.check`.
2. **`AcpAdapter.sessionUpdate`** (`src/adapters/acp.ts`) — a new `case 'usage_update':` calls
   `recordUsage` **directly, in-process**, no RPC — same reasoning as the permission handler
   calling `decideBlocked` directly: `AcpAdapter` already runs inside the daemon.

### 3.3 `cw session-usage-hook` — the Claude Code statusLine command

New CLI subcommand, structured identically to `cw radar-hook`: reads the statusLine JSON from
stdin, extracts `cost.total_cost_usd` and `context_window.total_input_tokens +
total_output_tokens`, resolves the session via `CW_SESSION_ID` (already injected into every
adapter-spawned process's env, same mechanism the hook uses), calls `session.reportUsage`, and
prints one short line to stdout for Claude Code to render as the actual visible status line
(e.g. `$0.0123 · 16.7k tokens`) — a small, near-free UX addition since the same payload is
already being parsed. Like the hook, it must never throw or block the agent: malformed input,
an unset `CW_SESSION_ID`, or a daemon that's unreachable all degrade to printing nothing and
exiting cleanly, never crashing Claude Code's status line renderer.

`radarHookSettings()` in `src/adapters/claude-pty.ts` gains a `statusLine` entry alongside the
existing `hooks.PreToolUse` entry, in the same `--settings` JSON object.

### 3.4 CLI surface

- `cw session new --budget-tokens <n>` and `--budget-usd <n>` — both optional, independent,
  passed through `session.new`'s existing params to `SessionRow.tokenBudget`/`costBudgetUsd`
  at creation. No budget set (today's universal default) means no warning ever fires.
- `cw session list` gains a spend column (`$0.0123` / `16.7k tok`, whichever budgets are set)
  and a plain-text warning marker when spend exceeds a set budget — no color/TTY-detection
  logic, matching this project's existing CLI output conventions (tab-separated, script-parseable).

## 4. Data flow

```
Claude Code (T2), after each assistant message
  -> statusLine command (cw session-usage-hook) invoked, JSON on stdin
  -> resolves session via CW_SESSION_ID -> session.reportUsage RPC -> recordUsage -> SessionRepo.updateUsage
  -> prints one status line back to Claude Code's own UI

Cursor (T1), mid-turn
  -> session/update { sessionUpdate: 'usage_update', used, size, cost? }
  -> AcpAdapter.sessionUpdate -> recordUsage (in-process, no RPC) -> SessionRepo.updateUsage

cw session list
  -> session.list RPC (unchanged) -> SessionRow now carries real tokenSpent/costSpentUsd
  -> CLI renders spend + budget-exceeded marker
```

## 5. Testing

- `recordUsage`: unit tests against a seeded `SessionRepo`, mirroring `decision.test.ts`'s
  style — tokens-only update, cost-only update, both, verifying only the provided fields change.
- `cw session-usage-hook`: mirrors `radar-hook.test.ts` — valid payload calls `reportUsage`
  correctly; malformed JSON, missing `CW_SESSION_ID`, and an unreachable daemon all degrade to
  a clean no-crash exit (same "never block the agent" bar the existing hook already meets).
- `AcpAdapter`'s `usage_update` handling: extends the fake ACP agent fixture with a new
  trigger marker (mirroring `__TOOL_CALL__`/`__REQUEST_PERMISSION__`) that sends a
  `usage_update` notification with controllable `used`/`size`/`cost`, asserting `recordUsage`
  was called with the right values.
- CLI: `cw session new --budget-tokens`/`--budget-usd` round-trip; `cw session list`'s spend
  column and over-budget marker, via the existing `tests/cli/cli.test.ts` end-to-end pattern.

## 6. Known limitation, stated honestly (goes into a new M6a-known-limitations doc at
## implementation time)

- **Not authoritative billing data.** Both sources are Anthropic's own client-side estimates;
  crossweave inherits that imprecision and must never imply otherwise in UI text.
- **Claude Code's statusLine cadence is "after every assistant message," not real-time** — a
  long single turn (a big tool call, a long thinking block) shows stale spend until the turn's
  message lands. Acceptable for a budget meter, not for anything time-critical.
- **ACP's `cost` field is optional and agent-dependent** — an ACP agent that never populates
  it (unlike Claude's own bridge, per the agents' own issue trackers) means `costSpentUsd`
  simply never updates for that session; `tokensSpent` (from `used`) is more reliably present.
- **No auto-pause yet** (§1 non-goals) — a budget is informational only until M6c can prompt
  through a TUI.

## 7. Out of scope / deferred

- OpenTUI dashboard rendering of any of this (M6c).
- Auto-pause on overrun, interactive user prompting (M6c).
- Per-turn usage granularity.
- Live push notification of usage changes (M6b's push-notification infrastructure could carry
  this later, but M6a's own consumer — `cw session list` — is a one-shot pull, so it isn't
  needed here).
