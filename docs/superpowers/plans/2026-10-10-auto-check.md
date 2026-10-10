# Auto-check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With an opt-in setting, run the session's trusted test command when a recognised agent ends a turn that changed the tree, and let the person paste a failed run's output into the shell (no Enter).

**Architecture:** The auto-checkpointer reports `turnEnded(sessionId, 'changed'|'unchanged'|'unknown')` after its `turn` take; a small pure `createAutoChecker` decides (setting on, tree not `unchanged`) and calls `startCheck(row)`, the body of `session.check` extracted so the RPC and the automatic path share one gate. The setting is a `checks` block in the user settings file (validated, mended by the cockpit's settings guard, a Switch in a new Settings section). Sending the failure is cockpit-only: a pure formatter plus the diff-comments delivery path generalised to `deliverText`.

**Tech Stack:** Bun, TypeScript strict, `bun:sqlite` (untouched), Preact (`@jsxImportSource preact` pragma in every `.tsx`), `bun test` at the repo root (which also loads cockpit tests) and in `apps/cockpit`.

**Spec:** `docs/superpowers/specs/2026-10-10-auto-check-design.md`

## Global Constraints

- `SCHEMA_VERSION` stays 18; no new dependency; no native module; macOS/Linux only.
- The automatic path runs only `converge.testCommand` behind the existing trust gate (`isTestCommandTrusted`), only with `checks.autoRun === true`, only for a recognised agent, never for `start`.
- The failure paste never carries Enter: `planSend(..., { enter: false })`.
- A new settings block goes in `settings-guard.ts`'s list and both `main.ts` call sites (AGENTS.md decision).
- Colours only through tokens; every new `.tsx` starts with `/** @jsxImportSource preact */`.
- Gates run one at a time (`bun test --max-concurrency=1`), the full root suite outside the sandbox (pty, sockets); never while another test run is going (a concurrent run made two 5 s timeouts and a hang last time).
- Comments explain WHY; user-facing copy in English; tests pin behaviour, not log strings.

## Review Focus

- A listener that throws (`turnEnded`, the checker's `run`, `enabled`) must never stop the status sweep or another session's status.
- `deps.take` returns `unknown` today: a double that returns `undefined`, a number, or a result without `created` must give `'unknown'`, not a crash.
- A session with no worktree of its own (`contextFor` → null): spec says `unknown` → run in the project folder. Is that wanted, or should it be skipped (no change detection, the folder is the person's own)? Decide in review.
- An agent that flaps `working → idle → working → idle` mid-turn: runs bounded by the dedupe and `CHECK_RUNNING`; the first run keeps going while the agent edits on (the verdict then shows stale).
- Test output with ANSI, OSC, `\r` progress bars, `\x1b[201~`, NUL, a 100 KB line, CRLF: the paste must read well and never close the bracketed paste early.
- `settings.json` with `checks: {autoRun: "yes"}` or `checks: 5`: loads as absent, saving it is refused; an older daemon must not drop the person's `checks` block (guard).
- Setting toggled while a turn is in flight: `enabled()` is read at `turnEnded`, not cached.

---

### Task 1: The `checks` settings block

**Files:**
- Modify: `src/core/settings.ts`, `apps/cockpit/electron/settings-guard.ts`, `apps/cockpit/electron/main.ts` (the two guarded call sites near line 401–405)
- Test: `tests/core/settings.test.ts` (new `describe('checks settings')` mirroring `persistence settings`), `apps/cockpit/tests/settings-guard.test.ts`

**Interfaces:**
- Produces: `export interface ChecksSettings { autoRun?: boolean }`; `UserSettings.checks?: ChecksSettings`; `export function cleanChecks(raw: unknown): { checks: ChecksSettings | undefined; problems: string[] }`; `GuardedSettings` gains `checks?: ChecksSettings`.

- [ ] **Step 1: Failing tests** — `loadSettings(home).checks` is `undefined` by default; round trip `{ autoRun: true }`; `saveSettings` throws `/checks/i` for `{ autoRun: 'yes' }` and for a non-object; a file with `checks: { autoRun: 'yes' }` loads as `undefined`; `{}` and `{ autoRun: false }` normalise (false is kept: it is an explicit choice that differs from absent only for display; keep `false` out to stay consistent with `persistence`: store only `true` — decide: `cleanChecks({autoRun:false})` → `{ autoRun: false }` kept, `{}` → undefined). Guard: `withGuardedFromFile({editor..}, { checks })` restores the block; `restoreGuarded({ settings: { checks } }, {})` returns it; an empty `checks: {}` is left alone.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement** (copy the `PersistenceSettings`/`cleanPersistence` shape: object check, `autoRun` boolean else `'checks autoRun must be true or false'`), wire into `validateSettings` problems, `loadSettings`, `saveSettings`; add `'checks'` to `GUARDED`, the type, and the `{ persistence, prompt, presets }` literals in `main.ts`.
- [ ] **Step 4:** `bun test tests/core/settings.test.ts` and `cd apps/cockpit && bun test tests/settings-guard.test.ts` → PASS; `bun run typecheck`.
- [ ] **Step 5:** commit `feat: a checks.autoRun setting (off by default)`.

### Task 2: `turnEnded` and the auto-checker (daemon, pure)

**Files:**
- Modify: `src/daemon/checkpoint-trigger.ts`
- Create: `src/daemon/auto-check.ts`
- Test: `tests/daemon/checkpoint-trigger.test.ts` (extend), `tests/daemon/auto-check.test.ts` (new)

**Interfaces:**
- Produces:

```ts
// checkpoint-trigger.ts
export type TreeOutcome = 'changed' | 'unchanged' | 'unknown'
// AutoCheckpointDeps gains:
//   /** A recognised agent's turn ended and its checkpoint was attempted. Never called for `start` or a plain shell. */
//   turnEnded?(sessionId: string, tree: TreeOutcome): void
// auto-check.ts
export interface AutoCheckDeps { enabled(): boolean; run(sessionId: string): void; log(message: string): void }
export interface AutoChecker { turnEnded(sessionId: string, tree: TreeOutcome): void }
export function createAutoChecker(deps: AutoCheckDeps): AutoChecker
```

- `take` in the trigger returns the outcome: `ctx === null` → `'unknown'`; resolved value's `created === true` → `'changed'`, `=== false` → `'unchanged'`, anything else → `'unknown'`; a throw is logged (as today) and is `'unknown'`.
- In `onChange`, for `kind === 'turn'` and a recognised agent, after the take: `try { deps.turnEnded?.(sessionId, tree) } catch (err) { deps.log(...) }` — a listener can never break the sweep.
- `createAutoChecker.turnEnded`: `tree === 'unchanged'` → return; `enabled()` (inside try; a throw → return); then `run(sessionId)` inside try: a `CrossweaveError` whose code is one of `CHECK_NOT_CONFIGURED`, `CHECK_UNTRUSTED`, `SESSION_NO_WORKDIR`, `CHECK_RUNNING` is swallowed silently; anything else is `log`ged. Never throws.

- [ ] **Step 1: Failing tests.** auto-checker: off → `run` not called; `unchanged` → not called; `changed` and `unknown` → called once with the id; each of the four codes swallowed with no `log`; a plain `Error` is logged once; `enabled` throwing → no run, no throw; `run` throwing a non-`CrossweaveError` → logged. Trigger: `turnEnded` gets `changed` for `{ created: true }`, `unchanged` for `{ created: false }`, `unknown` for `undefined`/`{}`/a throw/null context; not called for `start`, not called when `agentOf` is null, not called for the owed-start `poll` path; a throwing `turnEnded` is logged and the next call still works.
- [ ] **Step 2:** `bun test tests/daemon/auto-check.test.ts tests/daemon/checkpoint-trigger.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Keep the existing exports and behaviour; the private `take` becomes `async function take(sessionId, kind): Promise<TreeOutcome>`.
- [ ] **Step 4:** run → PASS; `bun run typecheck`.
- [ ] **Step 5:** commit `feat(daemon): report a turn's tree outcome and decide an automatic check`.

### Task 3: Wire it in `methods.ts`

**Files:**
- Modify: `src/daemon/methods.ts`
- Test: `tests/daemon/methods-check-auto.test.ts` (new, pty — run outside the sandbox)

**Interfaces:**
- Consumes: Task 1 (`loadSettings().checks`), Task 2.
- Produces: `buildMethods` option `autoCheck?: () => boolean` (default: `opts.startBackgroundJobs === true ? () => loadSettings().checks?.autoRun === true : () => false`); an internal `startCheck(row: SessionRow): void` holding everything `session.check` does after `sessions.resolve` (command present, trusted, worktree exists, `checks.start(...)`), so the handler becomes `const row = sessions.resolve(...); startCheck(row); return { ok: true }`.
- Wiring: `const autoChecker = createAutoChecker({ enabled: autoCheckEnabled, run: (id) => { const row = sessionsRepo.findById(id); if (row !== undefined) startCheck(row) }, log: daemonLog })`; `createAutoCheckpointer({ ..., turnEnded: (id, tree) => autoChecker.turnEnded(id, tree) })`.

- [ ] **Step 1: Failing integration test** (setup copied from `methods-checkpoint-auto.test.ts`: fake `claude` that is busy ~4 s, writes `agent-made.txt`, then idles): write `crossweave.config.json` with `converge.testCommand: 'test ! -f agent-made.txt'`, `config.trust`, `buildMethods(..., { shell: '/bin/sh', exposeSweep, autoCheck: () => true })`; start the session, run `claude`; drive `sweep()` until `session.list` shows the session's `check.state === 'fail'` with **no `session.check` call**. Second test, `autoCheck: () => false`: wait until `checkpoint.list` has a `turn` entry newer than the first poll (the turn ended), pause 1 s, assert `check` is absent. Third: `autoCheck: () => true` but no trust → turn ends, `check` stays absent and nothing throws.
- [ ] **Step 2:** run (outside the sandbox) → FAIL.
- [ ] **Step 3: Implement** as above; keep `session.check`'s observable behaviour and error codes byte for byte (`tests/daemon/methods-check.test.ts` must stay green).
- [ ] **Step 4:** `bun test tests/daemon/methods-check.test.ts tests/daemon/methods-check-auto.test.ts tests/daemon/methods-checkpoint-auto.test.ts --max-concurrency=1` → PASS.
- [ ] **Step 5:** commit `feat(daemon): run the trusted check when an agent ends a changing turn`.

### Task 4: Cockpit lib — format and deliver

**Files:**
- Create: `apps/cockpit/src/lib/paste-delivery.ts`, `apps/cockpit/src/lib/check-failure.ts`
- Modify: `apps/cockpit/src/lib/review-comments.ts` (use `deliverText`; re-export `Delivery`)
- Test: `apps/cockpit/tests/paste-delivery.test.ts`, `apps/cockpit/tests/check-failure.test.ts`; `review-comments.test.ts` stays green untouched

**Interfaces:**

```ts
// paste-delivery.ts
export type Delivery = { ok: boolean; message: string }
export function deliverText(o: { text: string; target: SendTarget; send: (id: string, data: string) => Promise<unknown>; done: string }): Promise<Delivery>
// check-failure.ts
export function formatCheckFailure(check: { code?: number; ms?: number; tail?: string; stale: boolean }): string
```

`deliverText`: `planSend(text, [target], { enter: false })`; a refusal → `{ ok: false, message: 'Not sent to <name>: <reason>' }`; `send` throwing → `{ ok: false, message: plainErrorMessage(err) }`; success → `{ ok: true, message: o.done }`. `deliverReview` keeps its message text and calls it.

`formatCheckFailure`: head `The project's tests failed` + ` (exit 1, 12.3s)` (each part only when known) + `, possibly out of date` when `stale` + `. End of the output:` + blank line + the cleaned tail, or `(no output was captured)`. Cleaning, in order: remove ANSI (CSI `\x1b\[[0-9;?]*[ -/]*[@-~]`, OSC `\x1b\][^\x07\x1b]*(\x07|\x1b\\)`, other two-byte `\x1b[@-Z\\-_]`); per line drop a trailing `\r`, then keep only what follows the last `\r` (progress-bar rewrites); drop trailing blank lines; keep the last 2000 characters (cut at a line start when possible).

- [ ] **Step 1: Failing tests** — `deliverText`: agent → one `\x1b[200~…\x1b[201~`, no `\r`, `ok`; plain shell with multi-line text → refused, `send` never called; closed shell refused; rejecting `send` → plain message; `\x1b[201~` inside the text appears only once at the end. `formatCheckFailure`: colours removed; `\r` progress keeps the last frame; CRLF; OSC title; stale wording present only when stale; exit and duration parts independently optional; empty/whitespace tail; a 100 KB tail is cut to ≤ 2000 from the end; text that is only ANSI becomes the empty-tail line.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** `cd apps/cockpit && bun test tests/paste-delivery.test.ts tests/check-failure.test.ts tests/review-comments.test.ts` → PASS.
- [ ] **Step 5:** commit `feat(cockpit): format a failed check for the shell and share the paste path`.

### Task 5: Cockpit UI — the setting and the menu item

**Files:**
- Modify: `apps/cockpit/src/lib/settings-sections.ts`, `apps/cockpit/src/ui/SettingsPage.tsx`, `apps/cockpit/src/ui/Sidebar.tsx`, `apps/cockpit/src/ui/ProjectView.tsx`
- Test: `apps/cockpit/tests/settings-sections.test.ts` (extend: the new section is in exactly one group and its row ids are unique), a walk test for the menu item (`apps/cockpit/tests/check-failure-menu.test.tsx` — only if the menu is a pure function; otherwise assert through `rowMenuItems`-style helper added in `rail.ts` and tested there)

**Interfaces:**
- `UserSettings.checks?: { autoRun?: boolean }` in `SettingsPage.tsx`; section `checks` (title **Checks**, sessions group, before `editor`) with one row `checks-auto-run` — label *Run checks when an agent finishes a turn*, description saying it runs `converge.testCommand` once it is trusted, in a worktree session, only after a turn that changed files; `SECTION_ICONS.checks`.
- `RowAction` gains `'sendFailure'`; the menu item **Send test failure to shell** is shown only when `menu.session.check?.state === 'fail'`; `ProjectView.rowAction` handles it with `handleSendFailure(sessionId)`: `formatCheckFailure(session.check)` → `deliverText({ text, target: sendTargetOf(session), send: api.sendInput, done: "Pasted the test failure into <name>'s shell — press Enter there to send it" })` → toast (info on ok, error otherwise).

- [ ] **Step 1: Failing tests** for the pure parts; **Step 2:** run → FAIL; **Step 3:** implement; **Step 4:** `bun test` in `apps/cockpit` (the tokens test included) and `bun run build` there → PASS; **Step 5:** commit `feat(cockpit): Checks setting and "Send test failure to shell"`.

### Task 6: Live check, limits doc, gates

**Files:**
- Create: `apps/cockpit/scripts/auto-check-check.ts`, `docs/superpowers/specs/2026-10-10-auto-check-known-limitations.md`; one line appended to `docs/superpowers/specs/2026-08-14-known-limitations-digest.md`; memory `ai-support-feature-series.md`.

- [ ] **Step 1:** the CDP script (pattern: `diff-comments-check.ts`): scratch HOME with `settings.json` `{ "checks": { "autoRun": true } }`, a repo whose `crossweave.config.json` has a failing `testCommand` and was trusted; a fake agent (`stty raw -echo`, copies stdin to a file, edits a file and goes idle); assert the chip becomes `✗ tests` with no click, the menu offers **Send test failure to shell**, and the bytes the fake agent received are one bracketed paste containing the failure text and no `\r`; with the setting off nothing runs. Start the cockpit and daemon from the **built** binaries of this branch (`bun run build` at the root first — the daemon must contain Task 3).
- [ ] **Step 2:** gates, one at a time and never concurrently with the hook's own run: `bun run typecheck`; `bun test --max-concurrency=1` (outside the sandbox); `cd apps/cockpit && bun test` (outside the sandbox); `bun run build` at the root; `bun run build` in the cockpit; the live script. Clean up Electron, daemons and scratch dirs (move to Trash).
- [ ] **Step 3:** write the limitations file and the digest line; commit the script and docs separately.

---

## Amendments from the adversarial review (these supersede conflicting task text above)

Verdict GO-WITH-FIXES; see the spec's "Amendments" for the reasoning. Concrete plan edits:

**Task 1.** `cleanChecks` keeps `autoRun: false` (like `cleanPersistence`); `{}` → `undefined`. Fix Step 1's contradictory sentence accordingly.

**Task 2.**
- `turnEnded?(sessionId, tree: TreeOutcome, to: 'idle' | 'asked')`. The trigger's private `take` returns `TreeOutcome | 'none'`: `ctx === null` → `'none'`
  and **`turnEnded` is not called** for it; `'unknown'` for a throw or a result without a boolean `created`.
- `createAutoChecker(deps)` deps: `{ enabled(): boolean; run(sessionId: string): void; log(message: string): void }`; returns
  `{ turnEnded(sessionId, tree, to): void; checkFinished(sessionId: string): void }`. State: `owed: Set<string>`, `active: Set<string>` (automatic runs in flight).
  ```ts
  const QUIET = new Set(['CHECK_NOT_CONFIGURED', 'CHECK_UNTRUSTED', 'SESSION_NO_WORKDIR', 'SESSION_NOT_RUNNING'])
  turnEnded(id, tree, to) {
    if (!on()) { owed.clear(); return }
    if (tree !== 'unchanged') owed.add(id)
    pump(to === 'asked' ? id : undefined)
  }
  checkFinished(id) { active.delete(id); pump() }
  function pump(skip?: string) {
    if (!on()) { owed.clear(); return }
    if (active.size > 0) return
    for (const id of [...owed]) {
      if (id === skip) continue
      try { deps.run(id); owed.delete(id); active.add(id); return }
      catch (err) {
        if (err instanceof CrossweaveError && err.code === 'CHECK_RUNNING') continue   // keep owed: pumped when that run finishes
        owed.delete(id)
        if (!(err instanceof CrossweaveError && QUIET.has(err.code))) deps.log(...)
      }
    }
  }
  ```
  `on()` wraps `deps.enabled()` in try (a throw is off). Nothing throws out of either method.
- Tests (pure, with a fake `run` that records and can throw): the old matrix; plus `asked` end marks owed but starts nothing and a later `idle` **unchanged**
  starts it; `changed` while a run is in flight (`CHECK_RUNNING`) is started by `checkFinished`; one automatic run at a time across two sessions, the second
  starting at the first's `checkFinished`; a disabled setting clears owed; a quiet code drops the mark and a later turn can re-owe it; a manual-run `CHECK_RUNNING`
  for session A does not block session B; and trigger tests: `turnEnded` is never invoked for a `'none'` outcome.

**Task 3.**
- `run: (id) => { const row = sessionsRepo.findById(id); if (row === undefined || (row.status !== 'running' && row.status !== 'waiting')) throw new CrossweaveError('SESSION_NOT_RUNNING', ...); startCheck(row) }`.
- The `CheckRunner` `onChange` becomes `(id) => { broadcast; if (checks.get(id, null, null)?.state !== 'running') autoChecker.checkFinished(id) }` (`checks`/`autoChecker`
  are referenced only when called, after construction; declare `autoCheckEnabled` before use).
- Harness: write `crossweave.config.json` with the failing `testCommand`, `buildMethods(db, root, undefined, loadConfig(root), { shell: '/bin/sh', exposeSweep, autoCheck })`,
  **then** `config.trust` (it hashes the in-memory config). Every test that asserts "nothing ran" first waits for the turn's checkpoint, then runs a positive
  control (a manual `session.check` reaches `fail`). Add a case: a second agent turn that changes nothing starts no run.

**Task 4.**
- `formatCheckFailure` runs `redactSecrets` on the tail (import from `../../../../src/core/redact-secrets.js`), then the widened cleaner:
  CSI `\x1b\[[0-?]*[ -/]*[@-~]`; OSC `\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)`; DCS/PM/APC/SOS `\x1b[P^_X][^\x1b]*(?:\x1b\\|$)`; other `\x1b[@-Z\\-_]`; then
  invisible format characters (`/[\u{E0000}-\u{E007F}​-‏  ‪-‮⁠-⁤⁦-⁩﻿؜]/gu`) removed.
  Tests for each (colon SGR, private CSI, DCS body, unterminated OSC, a tag-character payload, a token-looking line redacted).
- `displaySafe` in `review-comments.ts` also maps the tag block, zero-width and `﻿` to `⁇` (test added).
- `canSendFailure(session: { check?: { state: string } })` pure in `check-failure.ts` (true only for `fail`).

**Task 5.**
- Menu item placement: inside the existing `branch !== null` block after **Run checks**, shown only when `canSendFailure(menu.session)`.
- `handleSendFailure` re-reads `api.listSessions()` (falls back to current state), builds the target from the fresh row, then `deliverText`.
- Export `SECTION_ICONS` from `SettingsPage.tsx` and test that every `SETTINGS_SECTIONS` id has an icon; the row element carries `data-setting="checks-auto-run"` (via `SettingRow id`).
- The Settings description says: runs `converge.testCommand` (agent-written code, outside the agent's sandbox) once trusted, in worktree sessions, after a turn that changed
  files; the setting applies to every project.
- Update `src/convergence/trust.ts`'s comment ("runs only on an explicit `cw land --yes`" → also a manual check, and an automatic one when `checks.autoRun` is on).

**Task 6.** The limitations file records every item in the spec's "Known limits added".
