# crossweave M0 — known limitations carried into M1

**Date:** 2026-08-10
**Status:** M0 merged at `cf93611`. Everything below is a deliberate carry, not an
unknown. Each was found by review, adjudicated, and left in place with a reason.

None of these is a correctness defect in shipped behaviour. They fall into three
groups: gaps the milestone's scope excluded, correct fixes that lack a regression
guard, and one user-visible rough edge.

---

## 1. Excluded by M0's scope — M1/M2 close them

**No reconciliation on daemon start.** The runtime only knows processes *this* daemon
started. After a restart, a session row can still carry a pid from the previous daemon,
and killing it signals nothing. Signalling that pid directly is **not** safe — pids are
reused, and we would be killing an unrelated process. M2's reconciliation is the
designed answer: verify worktrees exist, probe recorded pids, release orphaned leases,
mark unreachable sessions dead.

**A detached daemon has no supervisor.** `connectOrStart` spawns it detached with stdio
ignored. A `kill -9`'d test run leaves it unreaped; fifteen orphans accumulated once
during development. Every pty *is* reaped when the daemon dies, but only because closing
the pty master SIGHUPs the session — an agent that `setsid`s itself out would survive.

**`daemon.shutdown` never unlinks the socket.** A stale `daemon.sock` survives every
`cw daemon stop`. Harmless: the next start hits `EADDRINUSE`, `isSocketLive` reports it
dead, unlinks and rebinds.

---

## 2. A killed session's name cannot be reclaimed — the one to fix first

```
$ cw session kill auth --rm-worktree --yes   →  killed auth
$ cw session new --name auth                  →  SESSION_NAME_TAKEN   (exit 1)
```

The `dead` row keeps the name under `UNIQUE(workspace_id, name)`, `branch` is never
cleared, the git branch `cw/auth` dangles, and `SessionRepo.delete` has no caller
anywhere in `src/`. There is no way to reclaim the name short of editing SQLite.

This is user-visible and larger than a cosmetic issue — reusing a session name is the
natural thing to do. It needs a product decision: either `kill` clears the name (and
the branch), or there is a `cw session rm` that removes a dead row.

---

## 3. Correct fixes with no regression guard

Each was verified working by direct behavioural probe; each survives having its fix
reverted with the suite still green. A future change could undo any of them silently.

| Fix | Why it is unguarded |
|---|---|
| `DaemonClient`'s socket `'error'` listener | `call()`'s `isConnected` pre-check means no test ever writes into a dead socket, so no `'error'` is raised. A white-box reproduction exists — stalled large write, peer death, one more raw write — but it must reach the private socket to bypass that check. **The current test's comment claims a guarantee the test does not provide; fix or delete it.** Note macOS returns EOF where Linux AF_UNIX returns `ECONNRESET`, so "unreachable here" is not "unreachable". |
| `fail()`'s `\r` collapse and `.trim()` | No test asserts on a message that actually contains `\r`. |
| `cw session stop` | No test references it at any level; deleting the subcommand leaves the suite green. |
| `kill()`'s `await onKill` and `clearRunning`'s terminal-state guard | They cover each other, so either single mutation is invisible. |

---

## 4. Small, known, low-impact

- **`cw daemon stop` on deadline expiry** prints `daemon stopped` and exits 0 even when
  its 2 s poll times out — the exact failure it was added to prevent, now silent rather
  than racy. Not reachable today: the only work left after the ack is a 10 ms timer.
  One line: throw `DAEMON_STOP_TIMEOUT`. Also worth noting in its comment that polling
  `isConnected` is sound **only** because `daemon.shutdown` never calls
  `daemon.close()`; if that changes, the race returns.
- **A missing required positional** (`cw session stop` with no target, same for `rename`)
  exits 1 but prints citty's own `Missing required positional argument` with no `CODE:`
  prefix, against the DoD's stated contract.
- **`MAX_LINE_LENGTH` bounds an unterminated line only.** A complete oversized frame
  arriving with its own newline is drained as an ordinary line; a 20 MB payload reached
  `onMessage`. The comment now says so.
- **`newId`'s 4-character counter wraps** at 32⁴ ids inside one millisecond, breaking
  lexicographic ordering. Measured throughput is ~300/ms, and ids stay unique either
  way — but M2's event ledger is what makes the ordering load-bearing.
- **`init('/x')` and `init('/x/')`** create two workspaces when the path does not exist.
  Unreachable in production: roots come from `git rev-parse`.
- **Each `bun test` process leaks one `cw-template-*` directory** (116 KB git repo). A
  small hygiene regression from the fixture rebuild, which otherwise removed a real
  hook-timeout risk.
- **Dead exports:** `WorkspaceRepo.findByName`, `listWorktreePaths`,
  `SessionRepo.delete`, `IdPrefix`, `RpcRequest` — each introduced by its task and
  abandoned by a later fix. Tests still reference the first three.
- **Absolute paths appear in some errors** (e.g. `WORKTREE_REMOVE_FAILED`). They are the
  user's own paths and carry no secrets, but if "no absolute paths in errors" is a real
  requirement it is not met.

---

## 5. Ruling on the native-dependency constraint

The plan said "ZERO native dependencies. Non-negotiable." That is not literally true:
`bun install` places a 24 MB prebuilt native `tsc` in `node_modules`, arriving as an
optional dependency of TypeScript 7.

The constraint was right about its purpose and wrong in its wording, and the plan's
Global Constraints now state the actual rule: **no dependency may run an install script,
and nothing native may reach a user.** A devDependency's prebuilt binary that executes
no install hook and ships inside neither `dist/cw` nor `dist/cwd` does not violate it.
A `.node` addon in the runtime graph does.

Verify with `bun pm ls` plus a check for `preinstall`/`install`/`postinstall`, not by
counting packages. At merge: 33 packages, 2 direct runtime dependencies, zero install
scripts, zero `.node` addons.
