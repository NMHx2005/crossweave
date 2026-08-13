# crossweave M6a — known limitations

Accepted gaps carried out of M6a (budget/burn backend), found and deliberately
deferred during implementation — see
`docs/superpowers/specs/2026-08-13-m6a-budget-burn-design.md` for the full design this
summarizes.

## Not authoritative billing data

Both usage sources — Claude Code's `statusLine` payload and ACP's `usage_update` — are
Anthropic's own client-side estimates. Anthropic's docs state this explicitly for both:
"client-side estimates... do not bill end users or trigger financial decisions from
these fields." crossweave inherits that imprecision. `cw session list`'s spend column
and any future UI built on `costSpentUsd`/`tokenSpent` must never imply otherwise.

## Claude Code's statusLine cadence is "after every assistant message," not real-time

Claude Code debounces statusLine updates at 300ms and only re-invokes the command on
specific triggers (a new assistant message, `/compact` finishing, a permission-mode
change, a `refreshInterval` timer if configured) — not continuously. A long single turn
(a big tool call, an extended thinking block) shows stale spend until the turn's
message lands. Acceptable for a budget meter, not for anything time-critical.

## ACP's `cost` field is optional and agent-dependent

`UsageUpdate.cost` is optional in the ACP schema — an agent that never populates it
means `costSpentUsd` simply never updates for that session over the ACP (T1) path;
`tokenSpent` (from `used`) is more reliably present, since it is a required field of
the schema. Whether a given ACP agent populates `cost` is entirely outside
crossweave's control and could change with no code change on crossweave's side either
way (same "implementation-quality, not structural" caveat M5b's known-limitations doc
already documents for `AcpAdapter`'s `locations` dependency).

## No auto-pause, no OpenTUI, no per-turn granularity

All three were explicitly out of scope for M6a (design doc §1 non-goals) and remain so:

- A budget set via `--budget-tokens`/`--budget-usd` is informational only. `cw session
  list` shows the `OVER BUDGET` marker; nothing pauses or interrupts the session. The
  design spec's "paused, not killed, and the user is prompted" needs a UI to prompt
  through — that is M6c's job, once there is a TUI to prompt in.
- No live-updating display of any kind. `cw session list` is a one-shot CLI query;
  seeing updated spend means running it again.
- Both usage sources report cumulative session-level totals only. A per-turn breakdown
  is not available from either without materially more invasive integration (parsing
  Claude Code's undocumented transcript JSONL, or waiting on ACP's still-draft End-Turn
  Token Usage RFD) and was not required for a budget meter, which only needs "how much
  so far."

## `session.reportUsage` resolves no workspace, and silently no-ops on an unknown session id

Deliberate, not an oversight: this is a high-frequency, best-effort call (Claude
Code's statusLine fires after every assistant message), and both callers (the
statusLine hook, `AcpAdapter` in-process) already know the exact session id from
`CW_SESSION_ID`/ACP's own permission-boundary wiring. Resolving a workspace or
validating the session exists would add work with no purpose on this path, and
`SessionRepo.updateUsage`'s plain `UPDATE ... WHERE id = ?` already degrades an unknown
id to "0 rows affected" rather than throwing — matching the "never block the agent"
posture this project's other hooks/best-effort paths already have.
