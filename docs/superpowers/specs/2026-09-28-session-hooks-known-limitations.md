# Session setup hooks — Known Limitations

**Date:** 2026-09-28
**Design:** `2026-09-28-mergeability-hardening-design.md` (Part B) · **Plan:**
`../plans/2026-09-28-mergeability-hardening.md`

## What is built

- `hooks.sessionSetup` is TYPED into the shell (via the same path as a launcher line) on
  a worktree session's first start, `&&`-chained with the launcher so a failed setup does
  not start an agent on a half-installed tree.
- `hooks.sessionTeardown` is spawned (best effort) in the worktree just before it is
  removed — `cw session rm` and `cw gc` — and a failure is a warning, never a block.
- Trust is separate: `cw config trust hooks` stores a `hooks_hash`
  (`config_trust.hooks_hash`), and `cw config trust` keeps trusting only
  `converge.testCommand`. Editing the hooks re-locks them.
- `cw session setup <name>` re-runs the hook (types it into an open shell, else arms it
  for the next start); `session.list` carries `setup: 'pending'` and `cw session list`
  shows a SETUP column when any row has one.

## Gaps

- **The setup's output is only in the pty.** The daemon types the hook and never learns
  its exit code — there is no shell to read one from. A failure is visible to the user in
  the terminal, not as a status; the rail can show `pending` before it runs, but never
  `failed`.
- **Marked as run when typed, not when it succeeds.** The once-marker is written the
  moment the line is typed. A shell that dies before executing it, or a hook that fails,
  will not re-run on its own — `cw session setup` is the way back.
- **Untrusted hooks are surfaced as a typed comment.** With a hook configured but not
  trusted, the daemon types a `# … not trusted …` line (which runs nothing) and skips it;
  the same reason is in `cw config status`. It is not a notification.
- **Worktree sessions only.** A session in the project folder (shared) has no worktree of
  its own and is never set up.
- **One line per hook.** No arrays, no per-session overrides, no conditionals in v1.
- **`sessionTeardown` runs with `process.env` only**, not the session's lease env (leases
  are released around removal): a teardown that needs `$PORT` or the compose project name
  must derive them itself. It runs as the user, unsandboxed.
- **`session.kill --rm-worktree` does not run the teardown** — only `session rm` and
  `cw gc` do.
