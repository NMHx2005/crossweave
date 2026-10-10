# Auto-check — run the session's tests when an agent ends a turn, and send the failure to its shell

**Date:** 2026-10-10
**Status:** Draft for review (the design was approved in chat 2026-10-10; this written spec is new)
**Branch:** `feat/auto-check` (third of four: checkpoints → diff comments → **auto-check** → sensitive-file flags; cut from `main`, which now
holds the first two)

## Why

After an agent's turn the person has to remember to press **Run checks**, wait, read the chip, and then copy the failure into the
shell by hand. The pieces already exist: the trusted `converge.testCommand` (`cw config trust`), `CheckRunner`, the `✓/✗ tests` chip,
the end of a failing run's output on `session.list`, and — since checkpoints — a way to know a turn ended *and whether it changed
anything*. Missing: starting the run on its own, and handing the failure back to the agent.

Success looks like: with the setting on, an agent finishes a turn that changed files, the chip turns `tests…` then `✓`/`✗` without
anyone clicking; on `✗` one menu item pastes the failure into the shell — and **nothing runs or is sent until the person decides**
(the paste has no Enter).

## Non-goals

- No automatic *sending* of the failure, and never an Enter.
- No new command and no new trust rule: the command is the one `land` and `cw check` already run, behind the same gate.
- No separate lint/typecheck commands, no per-session command, no desktop notification, no minimum interval between runs.
- No schema change (`SCHEMA_VERSION` stays 18), no new dependency, no native module.

## A. Run on turn end

**Trigger.** The status sweep reports `working → idle|asked` for a session. Today `createAutoCheckpointer.onChange` takes the `turn`
checkpoint for a recognised agent. After that take, it reports the outcome through a new optional dep
`turnEnded(sessionId, tree)`, where `tree` is `'changed'` (a checkpoint was created: the tree differs from the previous one — the
turn's `start` checkpoint, or the previous turn's), `'unchanged'` (deduped away) or `'unknown'` (the take failed or was skipped:
size guard, no worktree). It is called only for a recognised agent and only for `turn`, never for `start`.

**Decision** (`src/daemon/auto-check.ts`, `createAutoChecker({ enabled, run, log })`): on `turnEnded`,

| Condition | Action |
|---|---|
| setting off | nothing |
| `tree === 'unchanged'` | nothing (a turn that only talked costs no test run) |
| `tree === 'changed' \| 'unknown'` | `run(sessionId)` |

`run` is the same code the `session.check` RPC uses, extracted to one function `startCheck(row)` in `methods.ts`: it throws
`CHECK_NOT_CONFIGURED`, `CHECK_UNTRUSTED`, `SESSION_NO_WORKDIR` or `CHECK_RUNNING`. The auto path swallows those four silently (nothing
configured or trusted is a normal state; a run already going is the guard against a flapping status) and logs any other error. It
never throws into the status sweep.

**Opt-in.** A user setting `checks.autoRun` in `~/.crossweave/settings.json`, **default off**: a test suite can take minutes of CPU per
turn. The person wrote it, so it needs no trust step; the repository's command still needs `cw config trust`. The daemon reads the file
each time (like `persistence.terminals`), only a real daemon does (`startBackgroundJobs`); tests inject `opts.autoCheck`.

**What the person sees.** The existing chip. The run happens in the session's own worktree with the same environment as a manual run
(`CW_CHECK=1`).

## Setting plumbing (the rules in AGENTS.md)

- `src/core/settings.ts`: `ChecksSettings { autoRun?: boolean }`, `cleanChecks` (object, boolean only, anything else is a problem),
  validated in `validateSettings`, read in `loadSettings`, normalised in `saveSettings`; a corrupt block loads as absent.
- `apps/cockpit/electron/settings-guard.ts` and the two call sites in `main.ts`: `checks` joins `persistence`, `prompt`, `presets` (an
  older daemon would drop it and rewrite the file).
- Cockpit: `UserSettings.checks`, a **Checks** section (sessions group, before Editor) in `settings-sections.ts` with one row
  *Run checks when an agent finishes a turn* and its `Switch` in `SettingsPage.tsx`; the description says it runs `converge.testCommand`
  and only once it is trusted.

## B. Send the failure to the shell

- A row-menu item **Send test failure to shell**, present only when the session's check is `fail`.
- The text (a pure function, `formatCheckFailure`):

  ```
  The project's tests failed (exit 1, 12.3s)<, possibly out of date>. End of the output:

  <tail>
  ```
  - `possibly out of date` when the verdict is `stale` (the work changed since the run);
  - the tail is cleaned for reading: ANSI escape sequences (CSI and OSC) removed, a `\r` rewrite (progress bars) keeps only what stays on
    screen, trailing blank lines dropped, and it is cut at 2000 characters from the end (the daemon already keeps ≤ 2000);
  - an empty tail says `(no output was captured)`.
- Delivery is the existing path: `planSend(..., { enter: false })` — an agent in the shell gets one bracketed paste, a plain or closed
  shell is refused with its reason — then a toast. The delivery helper `deliverReview` (diff comments) is generalised to
  `deliverText(text, target, send, what)`; `deliverReview` becomes a thin caller and its tests stay.
- No daemon change for B: the verdict and tail already ride on `session.list`.

## Units

- `src/daemon/auto-check.ts` (new): `createAutoChecker`, `AutoCheckDeps`, `TreeOutcome`.
- `src/daemon/checkpoint-trigger.ts`: `turnEnded` dep; `take` returns the domain result so `created` can be read.
- `src/daemon/methods.ts`: `startCheck(row)` extracted; auto-checker wired to `turnEnded`; `opts.autoCheck`.
- `src/core/settings.ts`, `apps/cockpit/electron/{settings-guard,main}.ts`: the `checks` block.
- `apps/cockpit/src/lib/check-failure.ts` (new): `formatCheckFailure`; `lib/paste-delivery.ts` (new): `deliverText`, `Delivery`;
  `lib/review-comments.ts`: `deliverReview` uses it.
- `apps/cockpit/src/lib/settings-sections.ts`, `ui/SettingsPage.tsx`, `ui/Sidebar.tsx` (menu item, `RowAction 'sendFailure'`),
  `ui/ProjectView.tsx` (the action).

## Errors and edge cases

| Case | Behaviour |
|---|---|
| Plain shell reaches `working` on output | not a recognised agent: no checkpoint, no `turnEnded`, no run |
| Agent pauses mid-turn and the status flaps | each `idle` may take a checkpoint; a run starts only if the tree changed, and a run already going is `CHECK_RUNNING` (ignored) |
| Daemon restarts mid-run | no verdict is stored for an unfinished run (existing behaviour) |
| Session ended while a run is going | `CheckRunner` already forgets the entry; result dropped |
| `settings.json` unreadable | defaults: off |
| Failure text contains ESC, NUL, `\x1b[201~` | stripped by `cleanPromptText` after the ANSI pass; the paste frame cannot close early |
| Verdict is `running`/`pass` | the menu item is absent |
| Verdict is `fail` but the shell is a plain one | toast with the refusal reason; nothing sent |
| Cockpit older than daemon / daemon older than cockpit | an older daemon ignores `checks` (guarded); an older cockpit shows no setting and the daemon keeps the file's value |

## Testing

- `auto-check` (pure): off → no run; `unchanged` → no run; `changed`/`unknown` → one run; each of the four silent codes is swallowed
  and does not log; another error is logged; it never throws.
- `checkpoint-trigger`: `turnEnded` is called with `changed`/`unchanged`/`unknown` after a `turn` take, not after `start`, not for a
  plain shell, and a throwing `turnEnded` does not break the sweep.
- `settings`: round trip, rejects non-boolean, corrupt block loads as absent; `settings-guard`: mends `checks`.
- `methods-check-auto` (real wiring, pty, like `methods-checkpoint-auto`): with the setting on and a trusted `testCommand` that fails,
  a fake `claude` that edits a file and then idles → the session's check goes `fail` by itself; a second turn that changes nothing
  starts no run; with the setting off nothing runs.
- `formatCheckFailure` and `deliverText` (pure): ANSI/OSC, carriage-return progress lines, stale wording, empty tail, long tail cut from
  the end, agent paste without `\r`, plain shell refused; the existing `deliverReview` tests stay green.
- Walk tests for the Sidebar item (visible only on `fail`) and the settings row; the settings-sections test keeps every row id unique.
- A live script `apps/cockpit/scripts/auto-check-check.ts`: with the setting on, a fake agent ends a turn that fails the check → chip
  `✗ tests` with no click → **Send test failure to shell** → the bytes at a raw-mode fake agent are one bracketed paste with the failure
  text and no `\r`.

## Security

- The automatic part runs a command the person already trusted (`cw config trust`), in the same worktree, with the same environment as a
  manual run, only when they switched the setting on. An untrusted or unset command is never run.
- An agent can therefore *cause* a run (by ending a turn with a changed tree) — the same command a person could press. It cannot change
  the command: that comes from the repository config, behind the trust hash.
- Test output is untrusted (it can carry anything a program prints). It is pasted without Enter, after ANSI removal and
  `cleanPromptText`; a malicious line cannot execute, and the person reads it first. As with diff comments, an agent that later reads the
  paste reads that text too (a prompt-injection surface that already exists whenever test output is pasted).
- The setting is a boolean in a file the daemon already validates and the cockpit already mends.

## Known limits to record

Turn ends are inferred from the screen, so a pause can start an extra run (bounded by the dedupe and `CHECK_RUNNING`); a run tests the
session's own worktree, not the merged result; one command per project; no notification when an auto run fails (look at the chip);
a daemon older than the cockpit ignores the setting until restarted; plain shells and pane-only agents are never auto-checked.

---

## Amendments from the adversarial review (these supersede conflicting text above)

The review (Opus, read-only, ran hostile strings through the proposed cleaner) found no blocker and five major defects; all are adopted.

**A′. Deciding when to run — an owed run, not a one-shot.**
- **Correction found while building (supersedes the next two bullets' use of `idle`/`asked`).** The status inference reports a turn that simply
  finished as `asked` too (`session-status.ts`: "its turn ended without asking: finished, waiting for your next message — `asked` without `rang`"),
  so the activity cannot tell a finished turn from a question. The signal is `rang` (a permission prompt on screen, a bell): `turnEnded(sessionId, tree,
  asking)` carries `asking = status.rang`, read through a new `isAsking` dep. A turn that ended with `asking` only owes a run; one that ended
  without it pays it. Whenever the text below says "ended in `idle`" read "ended without asking", and "an `asked` end" read "an asking end".
- `turnEnded(sessionId, tree, to)` also carries the status the session moved to (`idle` or `asked`). `tree` is `'changed' | 'unchanged' | 'unknown'`.
  A session with no worktree of its own (`contextFor` → null: the shared project folder, a plain folder) is **never reported**: there is no
  change detection there, so every chat-only turn would run the suite in the person's own folder. A failed take (`unknown`, e.g. the 50 MB
  guard) still counts as "may have changed".
- The auto-checker keeps an **owed** set. A turn that ended with `changed` or `unknown` makes the session owed. A run is started for an
  owed session when the turn ended in `idle` — **even if that last turn is `unchanged`** — because `working → asked` is also what a
  permission prompt looks like, so an `asked` end only marks the session owed (running tests on half-finished edits at every approval is
  wasteful and, with `CHECK_RUNNING`, would drop the real final run). Starting a run clears the owed mark.
- **One automatic run at a time, daemon-wide** (AGENTS.md resource budget): while an automatic run is going, other owed sessions wait.
  A run that cannot start because the session already has one (`CHECK_RUNNING`, e.g. a manual run) keeps the owed mark; **when any check
  finishes**, the daemon asks the auto-checker to pump again, so the deferred or blocked run starts then. The four quiet codes
  `CHECK_NOT_CONFIGURED`, `CHECK_UNTRUSTED`, `SESSION_NO_WORKDIR`, `SESSION_NOT_RUNNING` drop the owed mark silently; other errors are logged
  and drop it too. A disabled setting clears the owed set.
- `run` refuses a session row that is gone or not running (`SESSION_NOT_RUNNING`): nothing forgets a `CheckRunner` entry when a session ends
  today (`CheckRunner.forget` has no caller), so the spec row "CheckRunner already forgets the entry" was wrong; the verdict of an ended session
  simply stays until the session row is deleted.

**B′. The failure text.**
- The tail goes through `redactSecrets` (`src/core/redact-secrets.ts`, the redaction used for every text the person may paste to an AI): the
  run inherits the daemon's whole environment, so a test that prints the environment would otherwise hand a token to the agent.
- Cleaning also covers colon-separated and private-parameter CSI sequences (`[0-?]*` parameters), DCS/PM/APC/SOS strings and an unterminated
  OSC (run to the end of the text), and **invisible format characters** (Unicode tag block U+E0000–E007F, zero-width and bidi controls,
  U+2028/2029, U+FEFF): a hidden "ignore previous instructions" must not pass where the person reads. The same hidden characters are
  now shown as `⁇` in diff-comment quotes (`displaySafe`).
- The menu item is offered through a pure `canSendFailure(session)`; before the paste the cockpit re-reads the session list, so a shell whose agent
  exited moments ago is not treated as an agent (a plain shell would run the pasted output line by line).

**Security, restated plainly.** Turning the setting on lets **an agent's own work cause a test run**: the command runs the code the agent has just
written, in the worktree, **outside the agent's sandbox**, with the daemon's full environment and network. A sandboxed agent that cannot reach the
daemon socket to run `cw check` can, with this setting, get a run by writing a test and ending its turn. The command itself still cannot be changed
(it comes from the repository config behind the trust hash). The setting is **global** (one file for the user): it arms every project whose
`testCommand` was ever trusted — until now trust meant "runs only on an explicit `cw land --yes` or a manual check". The Settings row says so, and
`trust.ts`'s comment is updated.

**Known limits added.** Change detection compares with the newest checkpoint of any kind, so it **misses** a run when a manual checkpoint (the person's,
or the agent's own `cw checkpoint`) was taken mid-turn, when edits predate a late-paid `start`, and when only ignored files changed; it **runs needlessly**
when a long suite's own untracked outputs (coverage, junit) land during the next turn, or the person edited between turns while `start` was dropped.
An automatic run races the agent's next turn in the same worktree (the verdict then shows stale). `CHECKPOINT_TOO_LARGE` trips on every turn, so
such a session is checked every turn (`unknown`). Manual runs are not counted in the one-at-a-time rule. A stale agent field on the rail can still
make the failure paste go to a shell that is plain (mitigated by the re-read; diff comments have the same window and do not re-read).
