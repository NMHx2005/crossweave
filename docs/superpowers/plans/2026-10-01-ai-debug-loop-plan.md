# Plan — AI debug loop (2026-10-01)

Spec: `docs/superpowers/specs/2026-10-01-ai-debug-loop-design.md`.
Status: plan is the live work item; tick steps only while it is.

## Phase 1 — status covers split panes (DONE 2026-10-01)

- [x] RED: regression tests — agent in an extra terminal keeps the session working /
  asks / gone / echo / quiet-shell / sweep (`tests/daemon/session-status.test.ts`)
- [x] `ActivityTracker.startedTerminal/terminalOutput/terminalInput/terminalResized/
  terminalExited` + aggregation in `status`/`sweep`
- [x] `TerminalObserver` on `TerminalRegistry` (started/output/input/resized/exited,
  `processes()` for the sweep)
- [x] `methods.ts`: pane shells in the `ps` sweep (`terminalAgents`), both `status()`
  call sites fold panes in
- [x] Gates: typecheck · `bun test --max-concurrency=1` (1655 pass) · build

## Phase 2 — `cw hooks install` / `cw hooks remove` (DONE, trừ live verify — gaps đã ghi vào limitations)

- [x] RED: tests — merge into an existing settings file (never rewrite foreign keys),
  backup, idempotence, malformed refusal, remove takes back exactly its own entries
  (`tests/core/agent-hooks.test.ts`, real files in a scratch home)
- [x] Claude Code entries (Stop → done, Notification → ask); format verified against
  the live `~/.claude/settings.json` of this machine (events inside a `hooks` object)
- [x] Codex: `notify` key in `~/.codex/config.toml` — inserted before the first
  `[table]`, only when absent; a foreign key refuses (`HOOKS_KEY_TAKEN`)
- [x] Gemini → `AGENT_NO_HOOKS` (no hook system to wire); unknown agent → one
  `INVALID_ARGUMENTS` line with the supported list
- [x] Atomic writes (temp + rename), pre-flight parse all, re-read at write time
  (TOCTOU), backup on first touch, provenance `~/.crossweave/hooks-installed.json`
  (0600) — per the design review's two criticals; the ORIGINAL FILE MODE is carried
  across the rename (0600 stays 0600 — these files can hold API keys)
- [x] Remove matches our fixed argument string, prefix-agnostic (installed from
  source, removed via PATH — still found); an entry bundling ours with the user's
  own keeps the user's hook
- [x] The hook's cw path resolved from the running binary (`cwHookPrefix`), sh-quoted
  and TOML-escaped; a `.ts` entry means bun-from-source
- [x] `cw notify` cwd fallback (no `$CW_SESSION_ID` / `--session` → resolve the
  session whose worktree is the cwd, canonicalised both sides: /var vs /private/var,
  symlinks, trailing slashes)
- [x] CLI `cw hooks install|remove <agent>` + `--yes`; piped without `--yes` →
  `CONFIRM_REQUIRED`; command tests + engine tests (real files in a scratch home)
- [ ] LIVE verification (needs a real agent session, owner runs it): confirm a
  Claude Code hook process inherits `$CW_SESSION_ID` — the cwd fallback covers the
  negative either way
- [x] Gates: typecheck · `bun test --max-concurrency=1` · build

Decision: one agent per invocation (multi-agent all-or-nothing becomes moot); add
more agents by extending `SUPPORTED_AGENTS`, `agentWiring` keeps the closed list.

## Phase 3 — `cw debug` (the debug bundle, CLI first) (DONE 2026-10-01)

> Tên lệnh đã chốt: `cw debug` (resolve session như `cw check`/`cw notify`:
> `CW_SESSION_ID` / `--session` / cwd fallback). RPC daemon: `session.debug`.

- [x] RED: bundle tests — verdict + failing tail + error lines + diffstat + latest
  words; every part optional, labelled (`tests/cli/debug.test.ts`)
- [x] RED: secret scrubber (`tests/core/redact-secrets.test.ts`) — token shapes,
  bearer, PEM, URL credentials, secret-named pairs; ordinary code/paths left alone
- [x] RED: error-line detector (`tests/daemon/error-lines.test.ts`) — bounded ring
  50 lines / 8 KB per session, dedupe key keeps identifiers (TS2345 ≠ TS2322),
  ANSI stripped, \r ends a line, the unfinished buffer capped (tail kept), RAM only
- [x] `sessionDiff` patch opt (the bundle wants the diffstat only; doc-type says
  patch==='' does not distinguish "no diff" from "off")
- [x] methods: `ErrorLines` fanned into the observers (session + panes), RPC
  `session.debug { idOrName, raw }` assembles, scrubs text AND paths, caps the
  file list (top 50 churn, total said), and `forget`s on rm/kill --rm-worktree/land
- [x] CLI `cw debug [session] [--raw]`; exits 1 when the check failed; smoke ok
- [x] Gates: typecheck · `bun test --max-concurrency=1` · build

## Phase 4 — Debug tab in the cockpit + send-to-session (DONE 2026-10-01)

- [x] Daemon: bundle as one RPC (`session.debug`) — DONE in Phase 3
- [x] Pane kind `debug` (`src/core/layout/index.ts`, paneKey case)
- [x] `apps/cockpit/src/lib/debug-pane.ts`: bundle types + `debugCheckLine` +
  `sendableText` (tail trước error lines)
- [x] `DebugPane` (hooks fetch mỏng) + `DebugBundleView` (pure, walk-test được):
  check chip → tail → Send to session…; errors (heuristic label); diffstat; latest words
- [x] Wiring: `api.debugBundle`, Stage label + BugIcon, `openDebug`, row menu
  "Debug…", `NEEDS_STAGE`, channel `session.debug`
- [x] "Send to session" = composer draft (`setComposerDraft` + `openComposer`) —
  preview chính xác vẫn là bước cuối trước khi gõ vào pane
- [x] Gates: cockpit test (576 pass) + build; main typecheck + suite (1716 pass) + build
- [x] Running-app check: standalone mount với bundle giả, CDP screenshot

## Phase 5 — prompt → responses view (DONE 2026-10-01)

- [x] The composer records the session ids it actually reached (`onSent(summary, ids)`
  — only the ones that took the prompt, not the refused ones)
- [x] `apps/cockpit/src/lib/responses.ts` — `responseRows(ids, byId)`: the rail's own
  `rowState`/`checkChip` per row, send order, vanished/duplicate ids dropped
- [x] `ResponsesDialog` + pure `ResponsesView` (name, rail state, latest words, tests
  chip; a click jumps to that session's pane via `focusSession`)
- [x] ⌘⇧R / Session menu "Responses…"; in-memory only (no persistence, per design §3)
- [x] Gates: cockpit `bun run build` (tsc + vite) · cockpit suite 581 pass · new
  `tests/responses.test.tsx` (5)
- [ ] Running-app check (CDP) — needs a running window with a live prompt

## Phase 6 — browser errors into the debug loop (CLI half DONE 2026-10-01)

- [x] `cw browser errors [--pane] [--since] [--limit]` — the page's console errors and
  its failed requests together: two bridge calls, so each kind keeps its own Read
  permission check in the cockpit, tagged by source (`buildBrowserRequests` /
  `formatBrowserErrors`; unit-tested in `tests/cli/browser.test.ts`)
- [ ] Debug pane pulls the ACTIVE browser pane's errors — needs a NEW renderer→main
  channel (`browser.console`/`browser.network` are served only over the command bridge
  today; the browser agent lives in cockpit main) plus a running-app (electron/CDP)
  check this environment cannot run — left for a follow-up
- [x] Gates (CLI half): typecheck · `tests/cli/browser.test.ts` 12 pass

## Milestone close

- [ ] `docs/superpowers/specs/2026-10-01-ai-debug-loop-known-limitations.md` + digest line
