# crossweave M3 — known limitations

Accepted gaps carried out of M3 ("Collision Radar"), for M4 and beyond. Each
was found, evaluated, and deliberately deferred (not overlooked) during
subagent-driven implementation and the final whole-branch review — see
`.superpowers/sdd/2026-08-11-crossweave-m3-collision-radar/progress.md` for
the full task-by-task ledger this doc summarizes.

## Security-adjacent — worth prioritizing early in M4

- **`contract.declare`'s daemon-side file read has no `assertContained`
  containment check.** The final-review fix wave moved the file read for
  `cw contract declare` from the CLI (client-side, main checkout) to the
  daemon (server-side, the owner session's worktree) to fix a wrong-worktree
  `sig_hash` bug — but the new `join(worktreePath, path)` read (in
  `src/daemon/methods.ts`'s `'contract.declare'` handler) never validates
  that `path` (derived from a client-supplied `symbolFqn`) stays inside
  `worktreePath`. Every other RPC handler and CLI command that touches the
  filesystem from an external-origin path goes through `assertContained`
  (`src/core/paths.ts`) first — this project's standing rule since M0. This
  one path was missed. Impact is bounded today: the socket is `0600`,
  reachable only by the same OS user, and the read only ever produces a
  signature **hash**, never file content — so this is a same-user
  path-traversal-shaped gap, not a privilege-escalation or cross-user data
  leak. Still, it's a one-line fix (`assertContained(worktreePath, path)`
  before the `readFileSync`) that should land before this handler grows any
  further.

## Noise control — one of the design's four mechanisms is unwired

- **`references()` (ripgrep-based reference scoping) is implemented and
  unit-tested but never called from any live delivery path.** Wiring it
  correctly needs the *recipient* session's live worktree contents to
  search, which the retroactive-notify path's tests deliberately don't model
  (in-memory DB rows, no real worktree) — see Task 7's plan-level scope
  decision. The other three noise-control mechanisms (whitespace/comment
  filtering at index time, rate limiting, coalescing) are live and working.
  Until reference scoping is wired in, notification volume is bounded only
  by the rate limiter (6 per session per 10 minutes, in-memory, resets on
  daemon restart) — not by whether the notified session actually cares about
  the symbol.

## Symbol extraction — narrow, disclosed gaps

- **`export default class { ... }` (anonymous default-exported class)
  contributes zero symbols** — its methods are extracted only when the class
  has a resolvable name. `export default function () {}` already had this
  gap before M3; the final-review fix wave's symbol-qualification change
  (below) widened it to classes too, as a side effect of correctly scoping
  method-name qualification to named classes. Zero occurrences in this
  repository today. A future fix: qualify with a `default.` prefix instead
  of skipping, since a file can have at most one default export.
- **TS function-overload signatures** (multiple `function_declaration` nodes
  sharing one name, only the last carrying a body) are not disambiguated the
  way class/interface methods now are (see below) — a rarer case than the
  same-named-method bug this milestone fixed, not addressed here.
- **Multi-declarator top-level `const`** (`const a = 1, b = 2;`) only claims
  the first declarator's name.

## Contract mechanism — one delivery path lags the other

- **`cw_declare_contract` (the MCP tool) still trusts an agent-supplied
  `source` string**, unlike `cw contract declare` (CLI/RPC), which the
  final-review fix wave changed to always read the owner session's own
  worktree copy server-side (fixing a wrong-worktree `sig_hash` bug for that
  path). The MCP path is lower-risk in practice — the calling agent's own
  context is normally exactly its own worktree view — but the two paths are
  no longer symmetric, and a future task should either make the MCP tool
  daemon-resolve its source the same way, or explicitly document why it
  doesn't need to.
- **A missing worktree file surfaces as a raw `ENOENT`/`INTERNAL` RPC error**
  instead of a clean `CrossweaveError`, from `contract.declare`'s new
  daemon-side read.
- **Symbol-scoped `cw_check` now needs a qualified `Class.method` name** to
  match a claim on a class/interface method (see below) — an agent that
  hand-types a bare method name will get an empty result. The tool's
  `inputSchema` description should be updated to say so explicitly.

## Performance — flagged, not blocking, worth addressing before scaling session count

- **`RadarIndexer.reindexSession` runs fully synchronously on the daemon's
  single event loop**: per changed file, one blocking `git show` plus up to
  two full tree-sitter parses (current content and fork-point content), with
  three blocking `git diff`/`ls-files` calls before that. A session with
  many changed files can block the daemon's event loop — including the
  socket serving `radar.check` itself, which a `PreToolUse` hook calls with
  a 5-second timeout — for the duration. Not exercised as a real problem in
  this milestone's own test suite (small fixtures throughout), but a
  realistic concern once several active sessions are editing large files
  concurrently. A worthwhile M4-or-sooner fix: batch the fork-point reads
  into one `git cat-file --batch` (or a single two-sided `git diff`) instead
  of one `git show` per file, and/or move the git subprocess calls off the
  main event loop.
- **`fs.watch(worktreePath, { recursive: true })` has no ignore filter**,
  and the indexer has no binary/size guard — `node_modules`, build output,
  and binary assets inside a worktree trigger full reindex passes and get
  read/hashed/git-shown in full on every change.
- **The debouncer is trailing-only, with no max-wait ceiling** — a worktree
  under continuous write pressure (a long build, a test watcher, very fast
  agent edits) can starve reindexing indefinitely.
- **`ContractService.hasContracts`/`autoSubscribeForPath` run `SELECT *`
  where `SELECT 1 LIMIT 1` would do** — correct, just chattier than
  necessary on every debounce tick in a workspace with contracts declared.

## Narrower, previously-documented gaps carried from individual tasks

- `radar.check` throws `SESSION_NOT_FOUND` if a colliding session's row is
  deleted between its claim being written and the query running — narrower
  in practice than it sounds, since claim deletion cascades from the same
  session-deletion paths, leaving no real reachable interleaving on this
  project's single-threaded daemon.
- The `body_hash` comparison in `checkCollisions` can, in principle, compare
  hashes computed from different granularities (a file-level hash vs. a
  symbol-level hash) in a crossover case — degrades to "always looks
  divergent," the safe over-notify direction, not a false negative.
- `--git-common-dir`-based project-root resolution (used by `cw radar-hook`
  to find the right daemon from inside a session's worktree) needs git
  ≥2.31 (2021); an older git silently falls back to the pre-fix,
  worktree-rooted (wrong) resolution.
- `repoRelative` path computation in the hook is only correct because
  `SessionRuntime` always launches an agent with `cwd` set to its
  `worktreePath` — true everywhere today, not structurally enforced.
- `CW_SESSION_ID` inheritance through the actual `claude` → hook-subprocess
  chain is plausible (this project's own env-passing plumbing does nothing
  to block it) but not independently verifiable from inside this repository
  — it depends on Claude Code's own internal hook-spawning implementation.
  `cw radar-hook` already treats an unset `CW_SESSION_ID` as a handled
  non-error case (degrades to `allow()`, no RPC call), which is the correct
  defensive posture given that residual uncertainty.
- The injected `PreToolUse` hook's `command` is built as a space-joined
  string, not an argv array — would break if a path component (e.g. the
  repo's own checkout path) contained a space. Unexercised in any current
  environment.
- `FileClaimRepo.deleteBySession` is implemented and tested but has no
  production call site yet — dead code, reserved for whenever a session's
  claims need bulk clearing outside the reindex-driven reconciliation path
  that already handles the common case.
- `notifyCollisions` sends through `MessageBus.send`, which — unlike
  `broadcast` — applies no liveness filter, so a `dead` session (killed
  without `--rm-worktree`) can still accumulate inbox messages it will never
  read, and can still appear in another session's collision set. Arguably
  correct (that worktree's divergent work is real until `cw land`), but the
  two delivery paths (`send` vs. `broadcast`) disagree on what "reachable"
  means.
