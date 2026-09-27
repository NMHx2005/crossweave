# Cockpit phase A (live tabs, find, finished, usage) — Known Limitations

**Date:** 2026-09-27
**Plan:** `docs/superpowers/plans/2026-09-27-cockpit-roadmap.md` (Phase A)

## What is built

- **Tabs stay live**: every tab is rendered, the inactive ones hidden; switching tabs no
  longer re-attaches or replays (checked: the same terminal element after a round trip,
  with the output printed while hidden).
- **Find in a terminal** (Edit → Find ⌘F, Find Next ⌘G, Find Previous ⌘⇧G): a find bar
  over the focused pane with a match count, case / whole word / regex, highlights.
- **Finished vs asking**: the daemon reports whether a session rang since the user last
  typed (`rang`). A quiet agent that rang is asking ("waiting for you"); one that went
  quiet without ringing has finished — a "finished" notification and a ✓ on its row
  until it is looked at. Plain shells never "finish".
- **Usage**: tokens per session read incrementally from Claude Code and Codex logs
  since the session was created (Claude messages deduplicated by id, Codex running
  totals differenced), per model; cost from prices the user sets in Settings → Usage;
  the project heading shows the project's total.

## Gaps

- **"Finished" rests on the bell.** An agent that asks without ringing (Claude Code
  rings only when its terminal-bell notifications are on) is reported as finished; one
  that rings on completion is reported as asking. The rail's colors are unchanged
  (quiet agent = amber).
- **Only Claude Code and Codex logs are read**; other agents show no usage.
- **No usage for sessions in the project folder** (changed 2026-09-28): every Claude run
  there — in crossweave or in a terminal outside it — writes to the same log folder, and
  nothing in a log says which shell ran it. Counting the folder's logs showed 326M tokens
  on a session nobody had used. Only sessions in their own worktree show figures, and the
  project heading sums those. Attributing by when an agent ran under a session's shell
  was considered and rejected: it misattributes whenever another Claude runs there too.
- **No prices ship**: costs appear only for models the user priced; with some models
  unpriced the figure is a floor ("$4.10+").
- **A log over 64 MB is read from its last 64 MB** on the first read.
- **All tabs' terminals stay in memory** (each keeps its scrollback).
- **⌘F reaches terminal panes only**; in the file editor it does nothing yet.

## Test note

- **`tests/convergence/land.test.ts` › "a successful land still returns the real
  LandResult…" timed out once (10 s) in the stop-gate's full parallel run**, next to a
  "killed 1 dangling process". It does not touch this phase's code (no session.list),
  passes alone in ~0.55 s (3/3) and in two further full default-concurrency runs
  (947/947 each). Treated as load-sensitive, not fixed by raising its timeout; if it
  recurs, look for what the dangling process was waiting on (a git lock in the
  fixture is the first suspect).
