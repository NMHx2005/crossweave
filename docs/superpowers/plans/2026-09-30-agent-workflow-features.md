# Plan — agent workflow features

Spec: `docs/superpowers/specs/2026-09-30-agent-workflow-features-design.md`
Tier: Large (four phases, stacked branches). A phase ends with the gate, a known-limitations file and a digest line.

## Phase 1 — `cw notify` (`feat/cw-notify`)

1. [x] Tracker: `signalled(id, kind)`; cleared by `input`; `session.list` carries `signal`. Tests first.
2. [x] RPC `session.notify` (validation, closed kinds, one-line message) + CLI `cw notify`.
3. [x] Cockpit: a new `done` signal marks the row ✓ and notifies when away; `ask` is the amber path already there.
4. [x] Measure on the real app (`scripts/notify-check.ts`).
5. [x] Docs.

## Phase 2 — session checks (`feat/session-checks`)

1. [x] Extract `land`'s trusted test runner; `session.check` RPC + `cw check`; per-session single flight, timeout, tail.
2. [x] Verdict with the worktree state it ran against; stale detection.
3. [x] Rail chip + "Run checks" action.
4. [x] Docs.

## Phase 3 — compare (`feat/session-compare`)

1. [x] Pure view model: two diffs, shared files, verdicts. Tests first.
2. [x] Compare modal + rail menu entry + per-side land.
3. [x] Docs.

## Phase 4 — prompt composer (`feat/prompt-composer`)

1. [ ] Settings block `prompt.refine` (validated) + Settings section.
2. [ ] `prompt.refine` runner in main (argv, stdin, timeout, cap) — from the saved settings only.
3. [ ] Paste framing (bracketed / single line) and `session.input` fan-out; refusal rules. Tests first.
4. [ ] Composer dialog (⌘⇧P): draft, refine proposal, session list, exact preview, Send, optional Enter.
5. [ ] Real-app measurement, docs.

## Gate (each phase)

`bun run typecheck` · `bun test --max-concurrency=1` · `bun run build` · cockpit `bun test` + `bun run build` · the phase's script.
