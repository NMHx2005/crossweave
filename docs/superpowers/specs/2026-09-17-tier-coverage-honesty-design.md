# Enforcement coverage, stated honestly

**Date:** 2026-09-17
**Status:** Implemented (steps 1–2). Step 3 (OS-level sandbox) is a proposal, not built.
**Scope:** Safe Mode tiers T1/T2 and the Collision Radar's coverage of writes made
through the agent's shell. Touches `src/adapters/acp.ts`, `src/cli/commands/radar-hook.ts`,
`src/radar/`, `src/daemon/`, and the user-facing tier labels.

---

## 1. The two things that were wrong

Both come out of the limitations digest's Bash paragraph
(`2026-08-14-known-limitations-digest.md`). The first is a documentation error, the
second is a real bug in the code.

**A. The digest overstated the gap.** It said a `Bash` write is "invisible to both Safe
Mode and the Collision Radar". Half of that is false: the Radar's `fs.watch` indexes the
worktree, so a file written by `sed -i` *does* become a claim — it just becomes one 500ms
after the fact and with no pre-write warning. "The Radar never sees it" and "the Radar
tells you too late" are different claims, and only the second one is true.

**B. T1 fails open on a tool call it cannot evaluate.** `decideRequestPermission` in
`src/adapters/acp.ts` returned `allow_once` whenever `toolCall.locations` was empty, on
the reading that an empty location list means "nothing to check against". But "nothing to
check against" is not "nothing to do": the file itself documents the opposite posture —
a location outside the worktree, or a `decideBlocked` that throws, denies rather than
silently allowing, *because T1 is the tier whose entire job is to fail closed*. A
mutating tool call that names no file is exactly the case where the tier has nothing to
evaluate, and it was the one case where it allowed anyway.

## 2. What each tier actually sees

The list is the point of this document; the labels the UI prints are derived from it.

| Tier | Adapter | Sees | Does not see |
|---|---|---|---|
| T1 | ACP (`cursor`, unreachable since `cursor-agent` 2026.08 dropped ACP) | file-mutating calls that enumerate their target | `execute` (shell) — no evaluable target exists, ever |
| T2 | Claude Code PreToolUse/PostToolUse hooks (`claude`) | `Edit`/`Write`, blocking; `Bash` **after** the fact and advisory only | shell intent that leaves no trace in the command string (a script the agent wrote and then ran, `cd`-relative tricks) |
| T3 | print-mode (`cursor-print`) | nothing | everything |

Two consequences worth stating outright:

- **No tier blocks a write made through a shell.** A hook cannot parse arbitrary shell
  for file-write intent (M5a's own reasoning), and it must never *guess* a deny: a false
  positive here stops an agent mid-task for no reason the user can see. So the Bash path
  is deliberately advisory, and the honest fix is to say so everywhere the tier is
  printed rather than to promise blocking that does not exist.
- **No tier is a sandbox.** All three are cooperative: they intercept what the agent
  tells the harness about. An agent that ignores the contract, or a subprocess it spawns,
  is outside all of them — that is §4's job, not the hook's.

## 3. Decisions

**3.1 Bash becomes a watched tool, advisory-only.** The matcher gains `Bash`, and the
hook's Bash branch can never produce `permissionDecision: 'deny'` — not even when the
daemon's `blocked` verdict is true. A `deny` from a parsed guess would be a policy the
user never agreed to, on evidence ("this command mentions a path another session also
changed") that is genuinely weak. Bash advisories also pass *through* the noise gate,
unlike a real block: they are advisory spend like any other (`§4.8` of the M3 design).

**3.2 A `deny` stays reserved for what the daemon actually evaluated.** `radar.check`
returns `blocked` for a specific `(path, symbol)` pair. That is the only input allowed to
deny.

**3.3 Path extraction is best-effort, bounded, and never fatal.** A small pure module
(`src/radar/shell-paths.ts`) pulls write-ish targets out of a command string: `>`, `>>`,
`tee`, `sed -i`, `truncate`, `rm`/`mv`/`cp` destinations, `git checkout --`. It is a
regex pass over a quoted-string-aware split, not a shell parser — it will miss cases, and
missing a case costs an advisory, not a block. Extraction is capped (first 5 candidates)
so a pathological command cannot make the hook do unbounded RPC work inside its 5s
timeout.

**3.4 The hook reindexes immediately after a write-inducing tool call.** A `PostToolUse`
hook calls the new `radar.reindex` RPC with the paths that call plausibly touched, so:

- the claim exists before the *next* tool call asks about it, instead of up to 500ms
  later (the `fs.watch` debounce is unchanged and remains the fallback for writers that
  have no hook — a script, another process);
- the retroactive notice names the file that call wrote, which is what makes it
  actionable ("this just happened to X") rather than "something in your diff overlaps".

The debounce is deliberately *not* removed: it is the only path that catches writes no
hook describes.

**3.5 Coverage is printed, not implied.** A bare `T2` reads as "protected". Every place
the tier is shown to a human now shows what the tier covers — `T2 · Edit|Write` in the
CLI and the cockpit rail — from one shared label table (`src/adapters/coverage.ts`), so
the UI cannot drift from the table in §2.

## 4. Not in this change: the part that would actually close the gap

Steps 1–2 make the promise honest and make the Radar fast; they do not make a shell
write *impossible*. Closing it for real means an OS boundary around the session process,
which is a different kind of change (new runtime surface, per-platform code, interaction
with leases and worktrees) and is scoped as its own milestone — see §5.

## 5. Built: OS-level session sandbox

> **Update, 2026-09-18.** This section was a proposal; it is now implemented for
> macOS. The design that shipped — the shared-`.git` solution, the measured profile,
> and what it still does not stop — is `2026-09-18-os-sandbox-design.md`. The
> bullet list below is kept as the record of what was open *before* the work, and
> every open question in it is now answered in that document. Linux (`bubblewrap`)
> remains unbuilt.

### Original proposal (kept for the record)

**Goal.** A session's agent process runs inside an OS boundary such that it can write
only inside its own worktree and the paths its leases own, with network access opt-in.

- **macOS (BUILT):** `sandbox-exec` with a generated seatbelt profile (`allow file-write*` scoped
  to `subpath` of the worktree + leased caches/tmp, `allow network*` only when the
  workspace config opts in). Deprecated API, but present and adequate.
- **Linux:** `bubblewrap` (`--ro-bind /`, `--bind worktree`, `--unshare-net` unless opted
  in). Needs `bwrap` present; degrade to today's behaviour with a warning when absent.
- **Open questions to resolve in that milestone** — each one is a reason this is not a
  two-hour change: how a `deny` from the sandbox is surfaced to the user (it looks like a
  mysterious EPERM inside the agent's TUI); whether the worktree bind is enough for tools
  that resolve paths through `/tmp` (macOS `/tmp` → `/private/tmp`); what happens to
  `git`'s own writes into the *shared* `.git` directory of the main repo (worktrees share
  it — a strict read-only bind of everything outside the worktree breaks every commit);
  how leases and the sandbox negotiate ports; and an explicit escape hatch for users who
  need the agent to touch something outside.

Estimated shape: Large — new runtime surface, one platform adapter per OS, and a real
design question (the shared `.git` problem) before any code.
