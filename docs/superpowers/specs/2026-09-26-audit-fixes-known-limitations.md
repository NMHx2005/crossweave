# Audit fixes (2026-09-26) — Known Limitations

**Date:** 2026-09-26
**Branch:** `fix/audit-2026-09-26`
**Plan:** `docs/superpowers/plans/2026-09-26-audit-fixes.md`

## What is fixed

- Gateway fails closed: no configured token ⇒ every call refused; constant-time
  `verifyToken` (read token honoured, rotation applies per connection); unparseable,
  scalar and batch frames never forwarded; WebSocket `Origin` must match `Host`;
  `webRoot` paths contained (`/../.crossweave/gateway.token` used to be served).
- `session.data` E2E: a chunk that cannot be sealed is dropped, never sent in
  plaintext; the token is re-checked per chunk (issue/rotate apply without a restart);
  the session id is AES-GCM AAD; an undecryptable chunk becomes one visible notice.
- `cw gc` keeps killed sessions with unlanded work unless `--force`.
- Daemon exits within 5 s when its socket file is deleted or replaced, and never
  unlinks a socket it does not own; a `null` frame gets INVALID_REQUEST.
- Lease acquire is all-or-nothing.
- Sandbox: only this worktree's admin dir is writable (both providers); bwrap binds
  fanout dirs + `pack`/`info` and the branch's ref directory instead of all of
  `objects`/`refs/heads`; seatbelt regex paths escaped.
- T2 hook tells the agent when an edit went unchecked (daemon unreachable).

## Gaps

- **Remote E2E: control token only.** Since the follow-up (branch `fix/smoke-ux`) the
  browser client derives the session.data key with WebCrypto from the token it logged in
  with, so a control-token viewer sees output. The key is derived from the CONTROL token,
  so a read-token viewer still cannot decrypt (it is told so); giving read viewers output
  needs a separate read key, which the daemon does not seal with today.
- **bwrap parity is verified at the argv level only.** The real-bwrap integration suite
  needs Linux CI (`sandbox-linux` job). Remaining bwrap-only gaps: the branch's ref
  directory (`refs/heads/cw`) is shared with other sessions' `cw/*` refs, and file
  names inside a fanout dir are unrestricted (bwrap has no pattern binds). Both
  providers still grant `.git/logs` (reflogs) wholesale.
- **Fanout dirs are pre-created** in `.git/objects` on Linux (a bind needs an existing
  source). Harmless to git, but visible.
- **`session rm` still discards unlanded work** after `--yes` — it is the explicit,
  per-session path; only `gc` got the unlanded-work guard.
- **The Bash advisory stays silent** when the daemon is unreachable (it can never block,
  so there is nothing to downgrade); only the Edit/Write path reports it.
- **"Radar unreachable" rate limit** is a marker file in `os.tmpdir()`, per worktree,
  10 minutes. A tmpdir that cannot be written means a notice on every edit.
- **ConvergenceScheduler maps are not pruned.** `lastTrialHead`/`lastTrialAt` grow by
  distinct `workspace:branch` names over a daemon's life (keys are overwritten per
  branch, so recycled names do not grow it). Bounded in practice; pruning is only
  observable through private state, so it was left out.
- **Web client:** the token is read from `#token=` first (a fragment never reaches the
  server), but a pasted URL still lands in browser history. xterm.js is loaded from
  jsDelivr, so the viewer needs internet access. The session list is polled every 3 s
  (the change feed is not exposed through the gateway). The file explorer, tabs and
  Monaco stubs of the old page were dropped — they had never run.
- **An aborted test run in a restricted shell leaks daemons** (tests fail before their
  cleanup). The socket watchdog now bounds that to ~5 s once the fixture directory is
  deleted; before it, 53 such daemons were found alive from one sandboxed run.
