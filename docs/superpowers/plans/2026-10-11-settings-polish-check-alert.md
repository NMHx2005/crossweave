# Settings polish and a failed-check alert — implementation plan

> **For agentic workers:** implement task by task, test first. Steps use checkbox syntax.

**Goal:** Make the Settings page consistent (no repeated banner, one short summary and a folded Details per section, a steady column, fuller short sections) and raise a desktop notification, without the test output, when a session's check fails while the window is away; fix the order of cleaning and redaction in the pasted failure text.

**Architecture:** Cockpit only. Pure logic in `apps/cockpit/src/lib` (`check-alert.ts` new; `check-failure.ts` and `settings-sections.ts` edited); the page's pieces in `SettingsKit.tsx`; the page in `SettingsPage.tsx`; the alert is wired where `ProjectView` already notifies. No daemon, RPC, schema (stays 18) or dependency change.

**Tech stack:** Bun test, Preact, the existing token CSS (`apps/cockpit/src/ui/tokens.ts`, `app.css`).

**Spec:** `docs/superpowers/specs/2026-10-11-settings-polish-check-alert-design.md`

## Global constraints

- Every `.tsx` starts with `/** @jsxImportSource preact */` (root `bun test` loads cockpit tests). No literal colours and no literal `px` in CSS (use tokens, `var(--cw-hairline)`, `calc(...)`); tokens test enforces it.
- Comments say WHY only. English copy. No `any`, no `!`, no `@ts-ignore`.
- Run tests one at a time and outside the sandbox (`dangerouslyDisableSandbox`), `--max-concurrency=1`; never two runs at once (the Stop hook runs a suite in the background). Words such as `.env` or `secret` in a bash heredoc can be blocked by a hook: write such files with the Write/Edit tools.
- One logical change per commit, Conventional Commits, branch `feat/settings-polish-check-alert` (already created), nothing on `main`.
- A search for the pasted-text fix: `formatCheckFailure` lives in `apps/cockpit/src/lib/check-failure.ts`, tests in `apps/cockpit/tests/check-failure.test.ts`.

## Review focus (inputs the spec implies and no task's happy path covers)

1. A key split by a zero-width character, a bidi override or an escape sequence must still be redacted (Task 1).
2. The same failing run listed again after an out-of-order load, a daemon restart or a verdict that disappears and returns must alert once (Task 2).
3. A first snapshot, or a remounted project view, must never alert for a failure that was already there (Task 2, Task 3).
4. A session name with a newline or a bidi override must not reach the notification title (Task 2).
5. The auto-run row must keep its safety words visible (Task 4).
6. The centred column (`.cockpit-settings-content__inner`) must not move between a section with a scrollbar and one without (Task 5, live check).

---

### Task 1: Clean the failure text before redacting it (fix to feature 3)

**Files:** Modify `apps/cockpit/src/lib/check-failure.ts`; Test `apps/cockpit/tests/check-failure.test.ts`.

**Interfaces:** Produces `plainLine(text: string, max: number): string` (exported, used by Task 2): escapes, invisible and control characters removed, whitespace collapsed to single spaces, cut at `max` with an ellipsis. `formatCheckFailure` signature unchanged.

- [ ] **Step 1: Failing tests** — add to `check-failure.test.ts` (read the file first and follow its imports):

```ts
import { formatCheckFailure, plainLine } from '../src/lib/check-failure'

describe('the order of cleaning and redaction', () => {
  const run = (tail: string): string => formatCheckFailure({ code: 1, ms: 1000, tail, stale: false })

  test('a key split by a zero-width character is still redacted', () => {
    const out = run('pass​word=hunter2supersecretvalue')
    expect(out).not.toContain('hunter2supersecretvalue')
  })
  test('a key split by a bidi override or an escape sequence is still redacted', () => {
    expect(run('pass‮word=hunter2supersecretvalue')).not.toContain('hunter2supersecretvalue')
    expect(run('pass\u001b[0mword=hunter2supersecretvalue')).not.toContain('hunter2supersecretvalue')
  })
  test('bell, backspace and delete are removed, newline and tab stay', () => {
    const out = run('a\u0007b\u0008c\u007fd\n\te')
    expect(out).toContain('abcd\n\te')
  })
})

describe('plainLine', () => {
  test('one line, no control or invisible characters, cut with an ellipsis', () => {
    // The bidi override is removed, not replaced by a space: a space would split a key name and defeat redaction.
    expect(plainLine('a\nb‮c\t d', 20)).toBe('a bc d')
    expect(plainLine('x'.repeat(30), 10)).toBe(`${'x'.repeat(9)}…`)
    expect(plainLine('', 10)).toBe('')
  })
})
```

If the repository's secret scrubber needs a longer or differently shaped value to match `password=…`, use the shape its own test in `tests/core` (search `redactSecrets` tests) already proves is redacted, and keep the split character in the middle of the key name.

- [ ] **Step 2:** `cd apps/cockpit && bun test tests/check-failure.test.ts` → the new redaction tests FAIL (the key survives), `plainLine` not exported.
- [ ] **Step 3: Implement.** In `check-failure.ts`: add `const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g` (keeps `\n`=0x0a and `\t`=0x09; `\r` is handled by the rewrite collapse, so strip `\r` AFTER the collapse). Make `screenText` also remove `CONTROL` after it has collapsed `\r` rewrites, and change `formatCheckFailure` to `screenText(raw)` first and `redactSecrets(...)` second: `let tail = redactSecrets(screenText(check.tail ?? ''))`. Add `export function plainLine(text: string, max: number): string { const one = screenText(text).replace(CONTROL, '').replace(/\s+/g, ' ').trim(); return one.length > max ? `${one.slice(0, max - 1)}…` : one }`. Add a WHY comment: redaction runs on what a person would read, because an invisible character inside a key defeats the matcher and reappears when removed afterwards.
- [ ] **Step 4:** run the file → PASS; `bun run typecheck` at repo root.
- [ ] **Step 5:** commit `fix(cockpit): clean a failed check's output before redacting it`.

### Task 2: Decide which failed checks to announce

**Files:** Create `apps/cockpit/src/lib/check-alert.ts`; Test `apps/cockpit/tests/check-alert.test.ts`.

**Interfaces:**
- Consumes `ListedSession` (`apps/cockpit/src/lib/sessions.ts`: `id`, `name`, `check?: { state, at, ms?, code?, stale }`), `plainLine` (Task 1).
- Produces:
  - `createCheckAlerts(): { seed(sessions: readonly ListedSession[]): void; take(sessions: readonly ListedSession[]): ListedSession[] }` — `seed` records every failing, non-stale run as already told; `take` returns the sessions whose check is `fail`, not stale and whose `at` is not among the runs already told for that id (a `Set` per session, so a run told once is never told again however the snapshots are ordered), and records them (whether or not the caller shows them).
  - `checkAlertTitle(name: string): string` → `<plainLine(name, 60)>: tests failed`.
  - `checkAlertBody(check: { code?: number; ms?: number }): string` → `exit 1, 12.3s`, `exit 1`, `12.3s`, or `The project's tests failed`.

- [ ] **Step 1: Failing tests** (`check-alert.test.ts`, the cases named in the spec plus the ones the plan review found):

```ts
import { describe, expect, test } from 'bun:test'
import { checkAlertBody, checkAlertTitle, createCheckAlerts } from '../src/lib/check-alert'
import type { ListedSession } from '../src/lib/sessions'

type Check = NonNullable<ListedSession['check']>
const withCheck = (id: string, check: Check): ListedSession => ({ id, name: id, check }) as ListedSession
const failed = (id: string, over: Partial<Check> = {}): ListedSession => withCheck(id, { state: 'fail', at: 1, stale: false, ...over })
const withoutCheck = (id: string): ListedSession => ({ id, name: id }) as ListedSession
const ids = (list: ListedSession[]): string[] => list.map((x) => x.id)

describe('createCheckAlerts', () => {
  test('a pass, a run still going, a stale failure and a session without a verdict announce nothing', () => {
    const a = createCheckAlerts()
    expect(a.take([
      withCheck('a', { state: 'pass', at: 1, stale: false }),
      withCheck('b', { state: 'running', at: 1, stale: false }),
      failed('c', { stale: true }),
      withoutCheck('d'),
    ])).toEqual([])
  })
  test('a failure is announced once, however often the list repeats it', () => {
    const a = createCheckAlerts()
    expect(ids(a.take([failed('a')]))).toEqual(['a'])
    expect(a.take([failed('a')])).toEqual([])
    expect(a.take([failed('a')])).toEqual([])
  })
  test('a new run that fails again is announced again', () => {
    const a = createCheckAlerts()
    a.take([failed('a', { at: 1 })])
    expect(ids(a.take([failed('a', { at: 2 })]))).toEqual(['a'])
  })
  test('runs arriving out of order never announce a run already told: 1, 2, 1, 2', () => {
    const a = createCheckAlerts()
    expect(ids(a.take([failed('a', { at: 1 })]))).toEqual(['a'])
    expect(ids(a.take([failed('a', { at: 2 })]))).toEqual(['a'])
    expect(a.take([failed('a', { at: 1 })])).toEqual([])
    expect(a.take([failed('a', { at: 2 })])).toEqual([])
  })
  test('a verdict that disappears and returns with the same run is not announced again', () => {
    const a = createCheckAlerts()
    a.take([failed('a')])
    a.take([withoutCheck('a')])
    expect(a.take([failed('a')])).toEqual([])
  })
  test('what the first snapshot already held is told to nobody; what comes after is', () => {
    const a = createCheckAlerts()
    a.seed([failed('a')])
    expect(ids(a.take([failed('a'), failed('b')]))).toEqual(['b'])
  })
  test('a failure that is stale when first seen is never announced, and a pass between runs forgets nothing', () => {
    const a = createCheckAlerts()
    expect(a.take([failed('a', { stale: true })])).toEqual([])
    a.take([failed('a', { at: 1 })])
    a.take([withCheck('a', { state: 'pass', at: 2, stale: false })])
    expect(a.take([failed('a', { at: 1 })])).toEqual([])
  })
})

describe('the words of the alert', () => {
  test('title and body never carry output, and a hostile name is cleaned', () => {
    expect(checkAlertTitle('api\n‮secret')).toBe('api secret: tests failed')
    expect(checkAlertBody({ code: 1, ms: 12300 })).toBe('exit 1, 12.3s')
    expect(checkAlertBody({ code: 2 })).toBe('exit 2')
    expect(checkAlertBody({ ms: 900 })).toBe('0.9s')
    expect(checkAlertBody({})).toBe("The project's tests failed")
  })
})
```

- [ ] **Step 2:** run → FAIL (module missing).
- [ ] **Step 3: Implement** `check-alert.ts` with a `Map<string, Set<number>>` of told runs, `seed` and `take` as above, importing `plainLine` from `./check-failure` and the `ListedSession` type from `./sessions`. WHY comment on the map: run identity, not adjacent snapshots, because a load that resolves late (1, 2, then 1 again) would otherwise make a told failure look new.
- [ ] **Step 4:** run → PASS; typecheck.
- [ ] **Step 5:** commit `feat(cockpit): decide which failed checks deserve a desktop alert`.

### Task 3: The preference, the row and the wiring

**Files:** Modify `apps/cockpit/src/ui/SettingsPage.tsx` (`NotifyPrefs`), `apps/cockpit/src/ui/App.tsx`, `apps/cockpit/src/ui/ProjectView.tsx`, `apps/cockpit/src/lib/settings-sections.ts`; Test `apps/cockpit/tests/settings-sections.test.ts`.

**Interfaces:** Consumes Task 2. Produces `NotifyPrefs.checkFail: boolean`; registry row `notify-check-fail`.

- [ ] **Step 1: Failing test** in `settings-sections.test.ts`: the `notifications` section's row ids include `notify-check-fail`, and `searchSettings('tests fail')` finds it.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.**
  - Registry: add to `notifications` (after `notify-finish`) `{ id: 'notify-check-fail', label: 'When tests fail', description: "A run of the project's tests ended red while you look elsewhere. It never shows the output", keywords: 'notify alert test tests check failed red fail' }`.
  - `NotifyPrefs` gets `checkFail: boolean`; `App.tsx` reads a new key `NOTIFY_CHECK_FAIL_KEY = 'cw.notify.checkFail'` next to the other three (default on: `!== '0'`) and writes it in `onNotify`. Define the key where the others are defined.
  - `ProjectView.tsx`: a `const checkAlertsRef = useRef(createCheckAlerts())`. In the load, inside the existing `if (knownRef.current !== null)` block add `const failed = checkAlertsRef.current.take(loaded.sessions); if (away && hostRef.current.notify.checkFail) for (const s of failed) notifyCheckFailed(s)`; in the first-load branch (where `knownRef.current === null`, after `setSessions`) call `checkAlertsRef.current.seed(loaded.sessions)`. Add `notifyCheckFailed(session)` beside `notifyAsking`: `new Notification(checkAlertTitle(session.name), { body: checkAlertBody(session.check ?? {}), tag: \`cw-check-${session.id}\`, silent: !hostRef.current.notify.sound })` with the same `onclick` and the same try/catch comment style. Keep `session.check` optional-safe (it is present, because `take` returned it).
  - Any other place that builds a `NotifyPrefs` object literal (search `dockBadge:`) gets `checkFail`.
- [ ] **Step 4:** `bun test tests/settings-sections.test.ts`; root `bun run typecheck`; `cd apps/cockpit && bun run build`.
- [ ] **Step 5:** commit `feat(cockpit): a desktop alert, without the output, when a check fails`.

### Task 4: One shape for every section in the registry

**Files:** Modify `apps/cockpit/src/lib/settings-sections.ts`; Test `apps/cockpit/tests/settings-sections.test.ts`, `apps/cockpit/tests/settings-checks.test.tsx`.

**Interfaces:** `SettingsSection` gains `summary: string` and `details: string`. `checks` gains the row `checks-notify-link`. Consumed by Tasks 5 and 6.

- [ ] **Step 1: Failing tests**:
  - every section has a non-empty `summary` of at most 100 characters and a non-empty `details`;
  - every row description is at most 160 characters; row ids are unique across sections;
  - the `checks-auto-run` description contains `sandbox`, `every project` and `Off by default`;
  - `settings-checks.test.tsx`'s first test now expects `['checks-auto-run', 'checks-notify-link']`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement the copy** (exact strings; the test names any other row over 160 characters, shorten it by dropping its second clause and keep the words that matter in that section's `details`):
  - summaries — dashboard `What your projects and sessions cost in disk and memory.`; appearance `Fonts, theme and text size for the window.`; terminal `How the panes look and behave.`; keyboard `Every command's shortcut, and how to change it.`; launchers `What a new session can start with.`; editor `Where Cmd+click opens a file.`; notifications `When the cockpit tells you something while you look elsewhere.`; presets `One-click recipes for starting a session.`; prompt `The composer and its optional Refine step.`; checks `Run the project's tests when an agent finishes a turn.`; usage `Tokens and cost per session.`
  - details — dashboard: `Disk is measured in the background, so a figure marked ≥ is a lower bound. Suggestions only propose: nothing is stopped or deleted without asking.`; appearance: `Fonts and text size apply as you choose them and are saved as you choose them. The terminal's own font and colours are under Terminal.`; terminal: `Import reads the font, size, colours and cursor of Ghostty or iTerm2 once; nothing is kept in sync. Keeping terminals across a daemon restart saves recent output on disk, off by default.`; keyboard: `Change records the next keys you press; the menu updates as it is saved. A prefix key (Ctrl-A by default) followed by one key runs a command in a focused terminal.`; launchers: `The command is typed into the session's shell, in its worktree; when it exits you are back at the prompt. Your aliases and wrappers work (for example cx).`; editor: `Cmd+click on a path in a terminal opens it here, at the line and column when the program printed them.`; notifications: `Alerts appear when a session waits for you, finishes or its tests fail, while you look elsewhere (another app, project or tab). These apply right away. An alert never shows test output.`; presets: `A preset starts a session in one click from the new-session picker (⌘T): the launcher, an own worktree or not, shells that each run a command, and a Browser pane on the session's leased port. The commands are typed and run for you, so they are yours alone: they live in this settings file, never in a repository.`; prompt: `The prompt composer (⌘⇧P) writes one prompt and sends it to one or several sessions. Refine is optional: the program is yours (this app does not choose an AI); it reads the draft and prints a better one, which you read before it goes anywhere. Empty means the composer has no Refine button.`; checks: `Runs converge.testCommand in the session's worktree after a turn that changed files, once you have trusted it with cw config trust. A test suite can take minutes of CPU after every agent turn, which is why it is off by default. The verdict shows on the session's row; Send test failure to shell pastes the end of the output without pressing Enter.`; usage: `Tokens the agents in each session have used, read from their own logs (Claude Code, Codex). The logs carry no prices: add yours (USD per million tokens) to see cost; a model without a price shows as tokens.`
  - row copy: `checks-auto-run` → `Runs your trusted test command after a turn that changed files: code the agent just wrote, outside its sandbox, for every project. Off by default`; `notify-updates` → `A corner notice when a newer release exists. It asks GitHub for the latest version number, nothing else`; `prompt-refine-command` → `The program the Refine button runs: it reads the draft on stdin and prints a better prompt. Empty means no Refine button`; `preset-list` → `One-click recipes in the new-session picker: a launcher, a worktree, terminals that run a command, a Browser pane`.
  - new row: `{ id: 'checks-notify-link', label: 'Alert when a run fails', description: 'A desktop notification while you look elsewhere. Set under Notifications', keywords: 'notify alert desktop notification test fail' }`.
- [ ] **Step 4:** run both files → PASS; typecheck (TypeScript will flag every object missing the new fields).
- [ ] **Step 5:** commit `feat(cockpit): a summary and folded details for every settings section`.

### Task 5: The kit and the stylesheet

**Files:** Modify `apps/cockpit/src/ui/SettingsKit.tsx`, `apps/cockpit/src/ui/app.css`; Test `apps/cockpit/tests/settings-kit.test.tsx` (new), `apps/cockpit/tests/tokens.test.ts`.

**Interfaces:** Produces `SettingsDetails({ children })` in `SettingsKit.tsx`. CSS: `.cockpit-sdetails`, `.cockpit-settings-content__lead`, `scrollbar-gutter`. `Banner` and its CSS stay until Task 6, which is the commit that stops the page using them (deleting them here would break the build between commits).

- [ ] **Step 1: Failing tests.** `settings-kit.test.tsx` (walk helper as in `checkpoints.test.tsx`): `SettingsDetails` renders a `details` element whose first child is a `summary` with the text `Details`, followed by a sibling `p` with the body (the body is not inside the summary and the `details` is not inside a `p`). `tokens.test.ts`: the stylesheet contains `scrollbar-gutter: stable` inside the `.cockpit-settings-content {` rule, and the new summary/lead text colours are the existing `--cw-text-dim` on `--cw-surface` (already AA-checked; add nothing).
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.**

```tsx
/** Folded explanation under a section's cards; the safety facts are never put here. */
export function SettingsDetails({ children }: { children: ComponentChildren }) {
  return (
    <details class="cockpit-sdetails">
      <summary>Details</summary>
      <p>{children}</p>
    </details>
  )
}
```

CSS: add `scrollbar-gutter: stable;` to the existing `.cockpit-settings-content` rule; `.cockpit-settings-content__lead { margin: 0; padding: 0 var(--cw-space-3); font-size: var(--cw-fs); color: var(--cw-text-dim); }`; `.cockpit-sdetails { padding: 0 var(--cw-space-3); font-size: var(--cw-fs-sm); color: var(--cw-text-dim); }`; `.cockpit-sdetails > summary { cursor: pointer; width: fit-content; }`; `.cockpit-sdetails > summary:focus-visible { outline: var(--cw-hairline) solid var(--cw-accent); outline-offset: var(--cw-hairline); }`; `.cockpit-sdetails > p { margin: var(--cw-space-2) 0 0; line-height: 1.45; overflow-wrap: anywhere; }`. If the stylesheet has a shared focus-ring list near the other `:focus-visible` rules, add the summary there instead of a new rule.
- [ ] **Step 4:** both test files PASS; `cd apps/cockpit && bun run build`.
- [ ] **Step 5:** commit `feat(cockpit): a folded Details piece and a steady column for settings`.

### Task 6: The page

**Files:** Modify `apps/cockpit/src/ui/SettingsPage.tsx`.

**Interfaces:** Consumes Tasks 3–5.

- [ ] **Step 1: Write the live script first** (`apps/cockpit/scripts/settings-polish-check.ts`, modelled on `settings-check.ts` and `checks-check.ts`; reuse their CDP helpers). Safety first: it refuses to run unless `HOME` differs from the real user's home directory, `COCKPIT_PROJECT_ROOT` has a `crossweave.config.json` whose `converge.testCommand` is the sentinel `test -f ok.txt || (echo missing ok.txt; exit 1)` and a `.crossweave` of its own, and a `seed <dir>` subcommand prepares such a repository (it calls the same seed as `demo-shot.ts seed`, then writes the config and commits it) BEFORE the app is started; everything it changes (trust, sessions, the notification preference) is restored in a `finally`. It then asserts: (a) no `.cockpit-sbanner` in any of the 11 sections and no `.cockpit-snew`; (b) every section but Dashboard has a `.cockpit-settings-content__lead` and a `details.cockpit-sdetails`, and its first `.cockpit-sgroup` has a `.cockpit-sgroup__title`; (c) `.cockpit-settings-content__inner`'s `getBoundingClientRect().left` is identical across all sections (that element is the centred column; the outer pane would pass vacuously); (d) the Notifications section has a switch labelled `When tests fail`, on by default; (e) the Checks section shows the words `sandbox` and `every project` in view (not inside a closed `details`) and its `Open Notifications` button lands on the Notifications section with that row in view. Notification part: `Page.addScriptToEvaluateOnNewDocument` installs, on every load, a `Notification` stub that appends `[title, body, tag]` to `window.__alerts` (a counter the script reads and resets) and an `hasFocus` override read from `window.__away`; the script sets `__away = true`, makes a session, trusts the command, runs `cw check` on it (the command fails: `ok.txt` missing) and waits for the rail's `✗ tests` chip; the stub got exactly one call whose title ends `: tests failed`, whose body matches `/^exit \d+, [\d.]+s$/` and does not contain `missing`; a second failing run (a new `at`) gives a second call; a reload (stubs reinstalled, counters fresh) and a wait give none; with `__away = false` a new failing run gives none; with the switch turned off and `__away = true` a new failing run gives none, and the switch is turned back on in the `finally`.
- [ ] **Step 2: Implement the page.**
  - Remove the news altogether (the Dashboard is no longer news, and the page opens on it, so a mark would vanish before it was seen): delete the `Banner` import, `BANNER_KEY`, `readBannerGone`, the `bannerGone`/`dismissBanner` state and the `<Banner>` block; then delete `Banner` from `SettingsKit.tsx` and the `.cockpit-sbanner*` rules from `app.css`. Add to `settings-kit.test.tsx` a test that `SettingsKit` no longer exports `Banner` and that `app.css` contains no `cockpit-sbanner` or `cockpit-snew`. The stored dismissal key is left behind in people's storage, harmless.
  - Under the title: `<p class="cockpit-settings-content__lead">{findSection(section)?.summary}</p>` and, after `bodies[section]`, `<SettingsDetails>{findSection(section)?.details}</SettingsDetails>` — both skipped for the Dashboard (it has its own layout).
  - Remove the long `note` props that Task 4 moved into `details` (launchers, presets, prompt, usage "Tokens and cost", notifications); keep short ones (Fonts, Keyboard's line moves to details too).
  - Group titles: keyboard `Shortcuts`; presets add-card `Your presets`; checks `Automatic runs`; others already have one.
  - Notifications: three groups — `When a session needs you` (`notify-finish`, new `notify-check-fail` with `<Switch label="When tests fail" checked={notify.checkFail} onChange={(checkFail) => onNotify({ ...notify, checkFail })} />`), `How it tells you` (`notify-sound`, `notify-dock`), `Updates` (`notify-updates`).
  - Checks: before the auto-run group, `<SettingsGroup title="How it works">` with three `cockpit-srow` text rows (plain text, no `data-setting`): `Runs` — `Your trusted test command (converge.testCommand), in the session's own worktree.`; `When` — `After an agent's turn that changed files, one automatic run at a time.`; `Shows` — `A ✓ or ✗ tests chip on the session's row; Send test failure to shell pastes the end of the output.`. The auto-run group keeps its title `Automatic runs`, its switch, and gains the row `checks-notify-link` with a `cockpit-btn cockpit-btn--sm` button `Open Notifications` that calls `setSection('notifications'); setTarget('notify-check-fail')`.
  - Presets: the add card is titled `Your presets`; with `presets.length === 0` a `cockpit-scard__block` paragraph above the button reads `No presets yet. A preset is a recipe for a session you start often, for example "Web app": Claude Code in its own worktree, a shell running your dev server, and a Browser pane on the session's port.`
- [ ] **Step 3:** `bun run typecheck` (root), `cd apps/cockpit && bun run build`, then the whole cockpit test dir.
- [ ] **Step 4: Live run** outside the sandbox on a scratch HOME and repository, with its own `--user-data-dir` and port, then stop the app and its daemon (find by cwd) and move scratch directories to `~/.Trash`: all checks of the script pass; take a screenshot of Notifications, Checks, Presets and Terminal and look at them.
- [ ] **Step 5:** commit the page, then the script separately: `feat(cockpit): a calmer settings page` and `test(cockpit): live check for the settings polish and the failed-check alert`.

### Task 7: Records and the final gates

**Files:** Create `docs/superpowers/specs/2026-10-11-settings-polish-check-alert-known-limitations.md`; Modify `docs/superpowers/specs/2026-08-14-known-limitations-digest.md` (one line at the end), `docs/PROGRESS.md` (a Cockpit row, a changelog line, `Last updated`).

- [ ] **Step 1:** the limitations file follows the sensitive-files one: what shipped, verification (numbers from the real runs), the limitations listed in the spec's "Limitations to record" plus whatever the live run showed, ideas not built (a live Checks status needing a daemon method, a sound of its own for failures, alerts from a closed window, quiet hours, central observation across every project).
- [ ] **Step 2:** gates, sequentially and alone: `bun run typecheck`; `bun test --max-concurrency=1` at the root outside the sandbox (includes the cockpit tests); `cd apps/cockpit && bun run build`. Report the numbers; a failure is reported with its output, never reported as green.
- [ ] **Step 3:** commit `docs: record the settings polish and the failed-check alert`.
- [ ] **Step 4:** update `~/.claude` memory entry only if something non-obvious was learned. Leave `main` untouched: the merge is the owner's decision.
