# OS-level session sandbox

**Date:** 2026-09-18
**Status:** Implemented (macOS seatbelt + Linux bubblewrap — bwrap provider on `linux` when `bwrap` is on PATH).
**Scope:** the session process boundary. `src/isolation/sandbox.ts`, `SpawnOptions`,
the three adapters, daemon wiring (`SessionRuntime.start` + `session.start`), and the
`sandbox` config block.

---

## 1. Why this exists

Every tier crossweave ships (T1/T2/T3) intercepts what an agent *reports* about its
tool calls. Nothing stops a write made through a shell, a script, or a subprocess —
`2026-09-17-tier-coverage-honesty-design.md` §5 called that out as the gap and named
the fix: an OS boundary, not a cleverer hook. This is that boundary.

The promise is narrow and checkable: **a session process can write inside its own
worktree and nowhere else.** Network is off unless the workspace opts in.

## 2. What was measured before any of it was written

The shared-`.git` problem the older document deferred turned out to be the whole
design, so it was settled empirically first (macOS 26.6.2, `sandbox-exec`):

| Question | Answer (measured) |
|---|---|
| Does a linked worktree's gitdir live in the main repo's `.git`? | Yes — `<worktree>/.git` is a file holding `gitdir: <main>/.git/worktrees/<name>`, so a blanket read-only bind outside the worktree breaks every commit. |
| What does `git commit` actually need? | New loose objects **and their fanout directory** (`objects/ab/`), git's temporary object files (`tmp_obj_*`, created then unlinked), this session's own branch ref, the worktree's bookkeeping dir, `logs/`, `index`, `packed-refs`. |
| Does the object store need unlink? | No — git never rewrites an existing object, so create+data is enough there and an existing object cannot be touched. |
| Tighter than "all of `objects/`"? | Yes, by name shape: `objects/<2 hex>/<38 hex>` plus `tmp_obj_*`. Verified: planting `objects/evil.txt` is refused and rewriting an existing object is refused. |
| Network default + opt-in | Denied by default (`curl` fails), works with one clause added. |
| Does a real `claude` run inside it? | Yes, with two extras: `~/.claude` + `~/.claude.json` write access, and **mach-lookup for the keychain** — without the latter it reports "Not logged in", because its credentials are in the login keychain, not a file. |
| Are escapes blocked? | Verified blocked: deleting the main branch ref, deleting the main checkout's files, rewriting an existing object, planting junk in `objects/`, writing `.git/config`, planting a git hook, writing another session's worktree, writing `$HOME`. |
| Does a sandboxed agent still reach the daemon? | Not with a bare `(deny default)`: `connect()` on a unix socket is `EPERM` even though the socket is a file, so `cw radar-hook` (a grandchild of the agent, one invocation per tool call) would silently stop reaching the daemon. One `(allow network-outbound (remote unix-socket (literal "<daemon.sock>")))` clause restores it while outbound TCP stays denied. The MCP socket needs its own clause, and the literal must be the canoncialised path — seatbelt matches the resolved one, and `$TMPDIR` is handed out through `/var` (a symlink). |
| Is `(allow file-write* (subpath "/private/var/folders"))` needed? | **No — and it was a hole.** A first profile granted it "because a runtime needs a temp dir"; that is the OS temp root every process on the machine shares, and every escape probe below succeeded because the fixtures lived there. Removed it: with the session's `TMPDIR` pointed at its own temp dir instead, a real `claude` session, `node`, `bun` and a sandboxed `git commit` all still work, and the escape probes now fail as they should. |
| Does a later `allow` or `deny` win? | Neither "last" nor "most specific" — clauses are additive with deny taking precedence. Verified: `(deny file-write* (subpath …/sub))` after an `allow` on its parent refuses that subtree, and a later `allow` inside it cannot carve it back out. Not needed in the shipped profile (nothing is granted broadly enough to need an exception), but it is the rule the profile's safety rests on. |

## 3. The profile

Generated per session by `buildSeatbeltProfile()` — not a static file, because every
path in it is session-specific:

- **Write:** the session's worktree; its private temp dir
  (`.crossweave/sandbox-tmp/<sessionId>`, which the session's `TMPDIR` is pointed at, so
  temp files do not land in the shared `/tmp`); `~/Library/Caches`; `/dev/null`,
  `/dev/tty`; and the agent state the CLIs keep in `$HOME` (`~/.claude`,
  `~/.claude.json` — named explicitly, so the rest of `$HOME` stays read-only).
  Deliberately **not** `/private/var/folders` — see §2.
- **Write in the shared `.git`:** exactly §2's list, nothing else.
- **mach-lookup:** the few services the keychain needs. Without them a sandboxed session
  is a logged-out session, a worse experience than no sandbox at all.
- **Sockets:** `connect()` on the daemon's own socket and the session's MCP socket —
  a literal path each, and nothing else. Not the same thing as network: it is how the
  agent's hooks reach the daemon, and it is why a bare `(deny default)` broke them.
- **Network:** off unless `sandbox.network` is true in `crossweave.config.json`.
- **Escape hatch:** `sandbox.enabled: false` disables it, and the session logs that it did.

The profile is written to `<tmp>/cw-sandbox-<sessionId>.sb` and passed as
`sandbox-exec -f <file> <agent argv...>`.

On Linux the provider is `bwrap` (bubblewrap). `buildBwrapArgs()` builds the
prefix (`--die-with-parent`, `--unshare-pid/uts/ipc`, ro-binds for
`/usr`/`/lib`/`/etc`/`/bin`, private `/tmp`, `--bind` worktree + narrow git
subpaths + agent state + daemon/MCP sockets, `--unshare-net` when
`sandbox.network` is false) and `planSandbox` appends `-- <agent ...>` — the
same promise as seatbelt, expressed as mounts rather than a profile.

## 4. What this stops, and what it does not

**Stops:** a write outside the worktree from any process in the session's tree — the
agent, a script it wrote, a subprocess it spawned. That is the property no hook can give.

**Does not stop:** reads (`file-read*` is allowed; hiding the filesystem was tried and
breaks every runtime), writes inside the worktree (that is the agent's job), and
anything on a platform with no provider — `undefined` is returned there and the session runs
exactly as before. The absence is NOT silent: the daemon logs `session <name> runs
WITHOUT an OS sandbox (<reason>)` at start. It is not yet surfaced per-session in
`cw session list` or the cockpit rail — the tier labels there describe what the *tiers*
do, not the sandbox, and adding a sandbox column is a separate change. On Linux
`bwrap` (bubblewrap) is the provider; when absent the session runs unconfined
with `no-provider` (same reason code as darwin without a provider) and the
pure `buildBwrapArgs`/`planSandbox` linux branch plus a real-`bwrap` integration
suite cover the same escape table as seatbelt.

## 5. Relationship to the tiers

The sandbox is **orthogonal** to Safe Mode: T1/T2/T3 decide whether a *collision* is
blocked; the sandbox decides what the process *can* do at all. A T3 session (no
interception) inside the sandbox is still confined to its worktree — the first mechanism
here that does not depend on the agent's cooperation.
