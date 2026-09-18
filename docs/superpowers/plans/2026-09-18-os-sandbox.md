# Plan — OS-level session sandbox (P2 step 3)

**Spec:** `docs/superpowers/specs/2026-09-18-os-sandbox-design.md` (the source of
truth; its §2 is the measurement table this plan was executed against).
**Tier:** Large — a new runtime surface (a process boundary), touching config, the
daemon, all three adapters, and two existing docs.
**Status:** done.

## Why

Steps 1–2 of the tier-coverage work made the promise honest: no tier blocks a write
made through a shell. This closes the gap for real, on the one layer that does not
depend on the agent's cooperation — the OS.

## Measured first, written second

Every rule in the profile came from a probe, not a guess, and three of the probes
changed the design:

- a linked worktree's gitdir lives in the main repo's `.git`, so a blanket
  read-only bind outside the worktree breaks every commit → §2's object/ref rule set;
- a bare `(deny default)` refuses `connect()` on a unix socket, so the daemon the
  agent's hooks reach needs an explicit `remote unix-socket` clause;
- `(allow file-write* (subpath "/private/var/folders"))` was both **over-broad** (every
  escape probe passed because the fixtures lived there) and **unnecessary** (a real
  session works with `TMPDIR` redirected) → removed.

## Tasks

1. `src/isolation/sandbox.ts` — `decideSandbox` (whether, and why not),
   `planSandbox` (the wrapped argv), `buildSeatbeltProfile` (the rules). Pure enough
   to unit-test; the integration tests run the real `sandbox-exec`.
2. `sandbox: { enabled, network }` in `CrossweaveConfig` + `DEFAULT_CONFIG` (on, off)
   + validation (booleans, refused if not — this setting decides whether a boundary
   exists). `src/core/config.ts`.
3. `SpawnOptions.sandbox` carries the *spec*, not a built plan: each adapter knows its
   own argv, so the `sandbox-exec` line is assembled at the spawn site.
4. Wire it: `session.start` decides the spec (and logs the reason when there is none),
   `SessionRuntime.start` points `TMPDIR` at the session's private temp dir.
5. Tests: profile clauses (what it denies is the point), `decideSandbox`'s three
   outcomes, `planSandbox`'s argv/cleanup, `TMPDIR` plumbing, config validation, and a
   real-`sandbox-exec` suite that attempts each escape and a commit.
6. Docs: README (config + the guarantee), the known-limitations digest (the Bash gap
   now has a real answer), the tier-coverage spec §5 (proposal → built).

## Committed as

- `feat(isolation): confine each session in an OS sandbox` — the module, config,
  wiring, adapters, tests.
- `docs: record the sandbox measurements and what it does not stop` — the three docs.

## Gate

`bun run typecheck` · `bun run build` · `bun test` **outside the Codex sandbox**
(inside it, socket/port tests fail with EPERM and the seatbelt suite cannot nest —
both environmental; compare against `main`). The seatbelt integration tests need
`require_escalated` for the same reason: `sandbox-exec` cannot run inside the Codex
sandbox.
