# Plan — parallel-agents cockpit backlog

**Source:** feature backlog from `docs/superpowers/specs/2026-09-27-*` follow-ups, requested
2026-09-28. Six independent parts, one branch/worktree each, in this order (smallest and
most foundational first):

A. Session history (landed/deleted sessions survive their row's deletion)
B. `hooks.sessionSetup` exit-code tracking (closes a session-hooks known-limitation)
C. Run checks per session
D. Session presets
E. Side-by-side diff of two sessions
F. Broadcast one prompt to several sessions

Every part: TDD (RED→GREEN per task, own commit, Conventional Commits). Gate after each part
— `bun run typecheck` · `bun test --max-concurrency=1` · `bun run build` (+ `apps/cockpit`:
`bun run build` where touched) — then a `known-limitations.md` + digest line + report to the
user before the next part starts. No merge to `main`/the user's branch without explicit OK.

---

## Part A — Session history

**Problem:** `event.session_id` and `session_setup.session_id` are `ON DELETE CASCADE`, and
`cw session rm` / `kill --rm-worktree` / `cw gc` delete the `session` row outright. A landed
or killed session's entire record — including its `session.landed` event — disappears the
moment its row goes, so there is currently no durable history at all.

### A1. `session_history` table
- Migration (schema v15): `session_history(id, workspace_id FK CASCADE, session_id TEXT
  (no FK — the row it names is gone by the time this is written), name, agent_kind, branch,
  final_status CHECK IN ('landed','dead'), created_at, ended_at, token_spent, cost_spent_usd,
  note)`, indexed `(workspace_id, ended_at)`.
- **RED/GREEN** `tests/db/session-history-repo.test.ts`: `SessionHistoryRepo.record()` +
  `.listByWorkspace(workspaceId, limit?)` (newest first).

### A2. Wire the three deletion points
- **RED/GREEN** `tests/domain/session-history.test.ts` (via `SessionManager` + `gc`):
  `remove()`, `kill({removeWorktree:true})` and `collectGarbage`'s `reclaimEnded` each
  record a history row, snapshotting the row's fields, before deleting it. A session that
  is merely killed without `--rm-worktree` (still `dead`, row kept) records nothing yet.

### A3. Daemon RPC + CLI
- **RED/GREEN** `tests/daemon/methods-session-history.test.ts`: `session.history` returns
  the workspace's history, newest first, capped (default 50, `limit` param).
- **RED/GREEN** `tests/cli/session.test.ts`: `cw session history` prints a table
  (name, status, branch, ended, tokens); `--json`.

### A4. Cockpit panel
- **RED/GREEN** `apps/cockpit/tests/session-history.test.ts`: a `History` view lists the
  same rows; empty state; opened from the Sidebar.
- `apps/cockpit/src/ui/SessionHistoryPanel.tsx` (new) + a Sidebar entry point.

**Gate A** + `2026-09-28-session-history-known-limitations.md` + digest line → report.

---

## Part B — `sessionSetup` exit-code tracking

**Problem** (documented gap): the daemon types the setup hook into the pty and never learns
its exit code, so the rail can show `pending` but never `failed`.

### B1. A sentinel the daemon can observe
- Type the hook `&&`-chained with a sentinel write, e.g.
  `{ <hook>; } ; printf '\x1e{"cw_setup":"<sessionId>","code":%d}\x1e' $?`, and have the pty
  output reader (already parsing ANSI/OSC for other signals) recognize the framed sentinel
  and strip it before it reaches the terminal buffer.
- **RED/GREEN** `tests/adapters/pty-setup-sentinel.test.ts` (or wherever pty output parsing
  already has unit coverage): a chunked/split sentinel across reads is still recognized;
  ordinary output containing `\x1e` bytes (unlikely, but the framing must not misfire) is
  not falsely matched.

### B2. Persist and surface the result
- `session_setup` gains `exit_code INTEGER` (migration), set when the sentinel is observed.
- **RED/GREEN** `tests/daemon/methods-config-hooks.test.ts` / `session-setup-rpc.test.ts`:
  `session.list`'s `setup` field gains `'failed'` (exit_code present and non-zero), alongside
  existing `'pending'`.
- CLI `SETUP` column shows `failed`; cockpit rail badge adds a failed state (reuse the
  existing amber/red badge tokens).

**Gate B** + known-limitations + digest → report.

---

## Part C — Run checks per session

**Problem:** no way to know a session's tests/lint are green before Land except running them
by hand.

### C1. Config + trust
- `crossweave.config.json` gains `converge.checkCommand` (reuse the existing
  `converge.testCommand` trust gate — same hash-based trust, not a new one, since it's the
  same class of "run arbitrary shell in the worktree" risk).

### C2. Run + record
- **RED/GREEN** `tests/convergence/run-checks.test.ts`: `runChecks(sessionRow)` runs
  `checkCommand` in the session's worktree with a timeout, records
  `{status: 'pass'|'fail'|'error', ranAt, output tail}` — new `session_checks` table
  (one row per session, overwritten each run, not a history).

### C3. RPC + CLI + rail
- **RED/GREEN**: `session.runChecks` RPC (untrusted → `CONFIG_HOOKS_UNTRUSTED`-shaped
  error); `session.list` carries `checks: {status, ranAt} | undefined`; `cw session check
  <name>`; rail badge green/red/running, `cw session list` CHECKS column.

**Gate C** + known-limitations + digest → report.

---

## Part D — Session presets

**Problem:** starting "the usual shape" (worktree + launcher + `bun dev` terminal + a browser
pane on its port) is several manual steps every time.

### D1. Config shape
- `crossweave.config.json` gains `presets: [{name, launcher?, extraTerminals?: string[],
  browserPane?: boolean}]` — reuses the existing launcher/extra-terminal/browser-pane
  primitives (Deck-grade / launchers / terminal-pane milestones already built these; this
  part is only sequencing them), so no new execution primitive, only orchestration.

### D2. Apply on session create
- **RED/GREEN** `tests/daemon/methods-presets.test.ts`: `session.new` with `preset: <name>`
  runs the preset's launcher, opens its extra terminals, and (cockpit-only) opens its
  browser pane once the port lease is known.

### D3. CLI + cockpit
- `cw session new <name> --preset <name>`; cockpit's New Session dialog gets a preset
  picker sourced from config.

**Gate D** + known-limitations + digest → report.

---

## Part E — Side-by-side diff of two sessions

**Problem:** comparing two sessions' Changes today means opening each one's pane separately.

### E1. Daemon RPC
- **RED/GREEN** `tests/daemon/methods-diff-compare.test.ts`: `session.diffPair(a, b)`
  returns each session's `ChangesPane` data (already built) keyed by session, reusing the
  existing diff-reading path (512 KB cap, commits-only) rather than a new git reader.

### E2. Cockpit split view
- **RED/GREEN** `apps/cockpit/tests/diff-compare.test.ts`: two `ChangesPane`s side by side,
  a picker for the second session, a "Land this one" action per side.
- `apps/cockpit/src/ui/DiffComparePane.tsx` (new), opened from the Sidebar (pick two
  sessions) or a session's context menu ("Compare with...").

**Gate E** + known-limitations + digest → report.

---

## Part F — Broadcast one prompt to several sessions

**Problem:** running the same instruction on Claude + Codex on separate worktrees means
switching panes and retyping it each time.

**Design decision needed before coding** (flag to the user, do not guess): typing into a
pty is inherently agent-blind (crossweave has no agent model — see "Decisions already made").
Broadcasting text is safe and matches the existing launcher-typing mechanism; broadcasting
a *keypress* (e.g. Enter) is not always correct across different shells/agents mid-output.
Default: type the text into every selected session's shell, **do not** auto-submit — the
user presses Enter in each, or a "submit all" second action does it explicitly, separated so
a half-finished prompt in one pane is never auto-submitted.

### F1. Daemon
- **RED/GREEN** `tests/daemon/methods-broadcast.test.ts`: `session.broadcastType(ids[],
  text)` types `text` into each listed session's live pty (skips a session with no pty,
  returns which ids were skipped and why).

### F2. Cockpit
- **RED/GREEN** `apps/cockpit/tests/broadcast.test.ts`: a multi-select on the rail + a
  compose box; "Type to N sessions" / "Submit all" as two buttons.

**Gate F** + known-limitations + digest → report.
