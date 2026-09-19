# Plan — follow-ups from the 2026-09-18 review + UI audit

**Spec:** none separate; the audits below are the source of truth.
**Tier:** Medium (touches CLI, daemon, cockpit; no schema change).
**Status:** done (2026-09-20) — tasks 1–8 shipped on `main` (`a3ca952`, `1ca90c9`, `836a76f`, `08e36b5`, `4457245`); remaining here is the stale copy and the plan close-out. History rewrite for `4c8f162` is a §0 hard stop, so task 9 is closed by recording the correction here, not by rewriting.

## What the review claimed, and what I verified

I checked every claim before touching anything (`receiving-code-review`). Two are
measured, one is half-right, two are wrong:

| Claim | Verdict | Evidence |
|---|---|---|
| "6+2 tests break on CI because `session new` needs `claude` on PATH" | **Real, and worse than stated** | `Bun.spawn` throws synchronously on a missing binary. Simulated CI with `env -i PATH=/opt/homebrew/bin:/usr/bin:/bin` in a scratch repo: `session new` printed `RPC_ERROR: Executable not found in $PATH: "claude"`, **exit code 0**, and left a session row plus a **port lease (43000) held forever**. |
| "`new` → idle → `attach` already worked, so the commit's 'dead end' claim is false" | **Wrong** | On `main`, `attach` has `start: { default: true }` and calls `session.resume`. So `cw session attach alice` did auto-start. My commit body for `337312f` overstated the CLI case — but the *Cockpit* rail genuinely had no Start action and no verb existed for the UI's own empty-state text (`cw session start`). The body needs a correction, not the code. |
| "commit `4c8f162` contains the bodies of `337312f` and `29e2349`, with `EOF2`/`EOF3` leaked" | **Real** | `git log origin/main..HEAD` shows `EOF2`/`EOF3` and two extra commit messages inside `4c8f162`'s body. My heredoc nesting was wrong. |
| "Lease leaks when a start fails" | **Real** | Same simulation: `session list` showed `nobinary  idle  ...  port=43000` after the failed start. `leaseManager.acquire` runs before `runtime.start`, and the `finally` only clears the `starting` set. |
| "`:disabled` chips look fine" | n/a | Not claimed — I fixed that separately in `8f43aaa`. |

## Tasks

1. **`session new` is a create-only verb again.** I first tried keeping "new also
   starts the agent" and making the start best-effort. That was the wrong call on
   two counts: a CLI `new` that allocates ~400MB of agent and depends on a binary
   on PATH is a surprising create, and the convenience it bought is already covered
   by `attach` (which auto-starts) and the new `start`. Reverted to create-only,
   which also kills the CI break by construction.
2. **Release leases when a start fails** (kept — this was a real leak). `runtime.start`
   is wrapped so a throw releases the block just acquired, instead of a port block
   held for the daemon's lifetime by a session that never ran.
3. **`cw session start` keeps failing loudly.** A user who typed `start` wants to
   know it did not start; a best-effort exit there would hide a missing binary.
4. **Review the badge semantics** ✓ `1ca90c9` (stopped→`unknown`/`stopped`, `deriveAttention`+tests) (design decision, so state it). `ready` currently
   means "landable", not "healthy/running", and a stopped session therefore reads
   green. Decide and implement: a stopped/dead session gets `unknown`, not a green
   `ready` wash — and `working` for an idle session stays (that one is correct: an
   idle session is simply not doing anything yet). Update the attention test to
   encode the decision.
5. **`status: 'waiting'` is unreachable.** ✓ `836a76f` (doc comment in `src/db/repositories/session.ts`; no migration, grouped as live for future) — either wire the one signal that means it
   or record it as dead in the schema note. Preference: record it — inventing a
   writer for a status nothing produces is speculative (`AGENTS.md` §2).
6. **Delete the dead `.cockpit-session-pick` rules** ✓ `836a76f` (3 rules, zero markup) — done.
7. **`cw tui` gets a start action.** ✓ `4457245` (`s` → `session.resume`, idempotent) — its `n` binding only calls `session.new`, which
   is the same dead end the Cockpit had. Add a `s` binding that resumes the
   selected idle session, with the same "not startable" guard.
8. **Stop losing scrollback when a session stops**, and **re-key only the pane that asked** ✓ `836a76f` (forward `session.exit` → pane message) + `08e36b5` (per-pane re-key) — the reviewer's UX note, verified in the running app (scrollback kept, global re-key flickered 4 panes).
9. **Correct the `4c8f162`/`337312f` commit-body problem** ✓ closed by record (this file) — `4c8f162`'s body contains `EOF2`/`EOF3` and the bodies of `337312f`+`29e2349` from a heredoc nesting error; `337312f`'s body overstated the CLI dead-end (`attach` already auto-started). No history rewrite (`AGENTS.md` §0); `a3ca952` is the correction. Leftover stale copy fixed in this branch (`apps/cockpit/src/ui/Stage.tsx` empty-state text + `tests/cli/cli.test.ts` comment).

## Gate

`bun run typecheck` · `bun run build` · cockpit build · `bun test` **outside the
sandbox** (inside it, socket/port tests fail with EPERM — see the other plan), plus a
CI simulation with no `claude` on PATH.
