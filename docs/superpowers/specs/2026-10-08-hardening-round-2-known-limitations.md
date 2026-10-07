# Hardening round 2 — known limitations

Plan and decisions: `docs/superpowers/plans/2026-10-08-hardening-round-2.md`. Built on `feat/hardening-round2`.

## What shipped

- **Setup failure on the rail** — a `✗ setup` chip when `hooks.sessionSetup` failed (the daemon reports it only while hooks are trusted).
- **Session history** — the newest 500 rows per workspace are kept (trimmed on write); `session.history` / `cw session history` take
  `--status` and `--query` (a case-insensitive name substring, `%` and `_` literal); the ⌘⇧H dialog loads up to 500 and filters locally.
- **`cw debug`** — more failure shapes (Rust, Go, Node/JVM exception lines, npm 7+, pytest, `command not found`) and more token
  shapes in the scrubber (GitHub fine-grained, Slack, Stripe, Google, npm, GitLab, SendGrid, bare JWT, `ASIA…`, `Authorization: Basic`).
- **`cw daemon stop`** — end to end tests, including from inside a session worktree.
- **`converge.requireCheck`** (opt-in, needs a `testCommand`) — `land.session` refuses a session without a fresh passing check
  (`CHECK_REQUIRED`) before it closes terminals or stops anything; `cw land … --skip-check` is the explicit way past.
- **`cw check` runs with the session's lease environment** (`LeaseManager.envFor`, no allocation).
- **Compare** shows the background trial merge of the two branches: conflict, clean, or not tried.
- **Refine can be cancelled** (button, a newer refine, closing the composer).
- **Update notice** — a corner notice from GitHub's `releases/latest`, one switch (`updateCheck`, shared with the CLI), per-version Later.
- **Renderer bundle** — the editor loads lazily and xterm has its own chunk: the first load went from ~1.4 MB to ~274 kB.

## Limitations

- **The requireCheck gate lives in the daemon, not in the cockpit's UI.** The cockpit still shows its old "land anyway?" warning, and
  when the flag is on the daemon's refusal arrives as an error toast naming `cw check`. There is no cockpit control for `--skip-check`
  on purpose (a person who wants to override it can use the CLI), and no pre-emptive disabling of the Land button.
- **The gate trusts the verdict the daemon holds.** A verdict is stale-aware (git counts, terminal activity) but a check says nothing
  about the *merge result*: it still tests the session's own worktree.
- **`envFor` only describes leases a session holds.** A stopped session has none, so a check on it runs without `$PORT`/database
  values rather than taking a block; a check on a running session shares the session's own port block with the session's server.
- **Compare reads the latest pairwise trial**, which does not exist above `pairwiseSessionThreshold` sessions (default 8) or before the
  first debounce; it then says "not tried", never "clean". `test_fail` and `unverified` trials also read "not tried". A trial can be older
  than the branches' newest commits.
- **History** filters by name and final status only (no dates); the cockpit filters the loaded 500, so a long history needs the CLI's
  `--query` to reach rows the dialog's single load would not include. Trimming is silent.
- **The detector and the scrubber are still heuristics.** The new error shapes are anchored to line starts to keep prose out, so an
  error printed mid-line after a prefix (a timestamp, a logger name) is missed; `command not found` anywhere in a line counts. The
  scrubber knows token *shapes*: an unlabelled secret of no known shape is still not caught.
- **Update notice:** one unauthenticated request per ~6 h (30 min after a failure); a rate-limited or offline machine sees nothing and
  is never told why. "Download" opens the release page — there is no in-app update (that waits for a notarized app). The switch is the
  CLI's `updateCheck`, so turning it off also silences the CLI's own note.
- **Bundle:** the editor chunk (~656 kB) and the xterm chunk (~503 kB) remain above Vite's default warning size; the limit is raised to 700 kB
  with the reason in `vite.config.ts`. A file pane shows "Loading editor…" for the first open. The lazy load was checked by the build and
  tests, and **has not been checked in the packaged app yet**.
- **Dashboard thresholds are still fixed** (minimum 5 MB to propose a delete, idle windows, disk cache 60 s / deadline 8 s). They were
  left alone on purpose: no one has asked to move them, and each would need a settings block and a settings-guard entry.
- **Not changed, because the premise was wrong:** the 80×24 pane screen is not an inference bug — the screen is created at the pty's size
  and follows every resize (`runtime.ts`), so inference never reads a screen of the wrong shape. A shell spawned before any client
  attaches is simply 80×24 until the first resize.
- **Not built (owner's call):** the iOS remote app and notarization (and so "Restart to update"), the composer sending to non-session
  terminals, running `cw check` against the merge result.
