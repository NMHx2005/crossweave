# Plan — Audit fixes (2026-09-26)

**Source:** project audit of 2026-09-26 (four area reviews + gate run).
**Tier:** Large — gateway auth contract change, E2E wire change (AAD), gc semantics, >10 files.
**Branch:** `fix/audit-2026-09-26`, one commit per task; merge to `main` only on an explicit OK.

## Tasks

1. **Gateway fails closed.** No token configured ⇒ every call is refused (was: every call
   authed as control). Tokens compared in constant time via `verifyToken`; the read token
   is honoured. Unparseable / non-object lines are never forwarded. `cw gateway serve`
   issues a control token when none exists.
2. **Gateway WS Origin check.** A browser `Origin` must match the request `Host`; no Origin
   (non-browser client) is allowed. Closes drive-by localhost / DNS-rebinding.
3. **Gateway static server containment.** `webRoot` requests resolved and contained; `..`
   can no longer read `.crossweave/gateway.token`.
4. **E2E fail closed + AAD + live token detection.** Encrypt failure drops the chunk instead
   of sending plaintext; token presence is re-checked (by mtime), not frozen at boot;
   `sessionId` is bound as AES-GCM AAD. Clients surface an undecryptable chunk as a
   `session.decryptError` notification instead of dropping it silently.
5. **`cw gc` keeps unlanded work.** A `dead` session whose branch has commits not on base,
   or whose worktree is dirty, is kept (reported) unless `--force`.
6. **Daemon robustness.** Non-object JSON frames answered with INVALID_REQUEST; the daemon
   exits when its socket file is gone/replaced (watchdog) and `close()` unlinks only the
   socket inode it bound.
7. **Lease acquire rolls back** partially recorded leases when a later step throws.
8. **Sandbox.** bwrap binds only this worktree's `.git/worktrees/<name>` rw; the objects-dir
   gap is documented honestly. Seatbelt regex paths are escaped.
9. **Radar.** `sed -ni`/`-Ei` clusters detected as in-place; T2 hook tells the agent once when
   Radar is unreachable (still allows — fail-open is by design).
10. **Scheduler maps** evicted when a branch/workspace leaves the tracked set.
11. **CLI colour** only on a TTY (`NO_COLOR` for pipes).
12. **Hermetic packaging test** — daemon stopped in `finally`, survivor check scoped to the
    test's own daemon pid.
13. **Cockpit** — Open Recent rebuilt after the switch persists; decrypt errors shown in the
    pane; cockpit typecheck in the gate.
14. **Docs** — AGENTS gate command (`--max-concurrency=1`), known-limitations + digest line.

## Gate

`bun run typecheck` · `bun test --max-concurrency=1` (socket/pty tests outside the sandbox) ·
`bun run build` · `apps/cockpit` typecheck + build + a look at the running app.
