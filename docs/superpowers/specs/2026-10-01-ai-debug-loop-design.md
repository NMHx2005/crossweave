# Design — the AI debug loop: logs, hooks, responses and the browser (2026-10-01)

> Owner request (2026-10-01): tối ưu crossweave cho AI — khi chạy, log hiển thị phải giúp
> AI (không chỉ log thô), trình duyệt tích hợp trong app đi cùng vòng đó. Cùng sửa bug
> status khi một session có nhiều pane (đã fix, xem phần Status bao trùm pane phụ).

## The loop this closes

```
prompt (composer, N sessions) → agents work → status/notify exact (hooks) →
debug surface (failing tails, console/network errors, diff) →
send back into a session (prompt) → land (evidence-gated)
```

Everything below is text and views the person can read — no agent adapters, no
launcher of agents (removed 2026-09-27, do not reintroduce).

## 1. `cw hooks install` — exact status without manual wiring

`cw notify` is exact where the screen is a guess, but it only fires if a hook calls it.
Today the user wires hooks by hand (PROGRESS.md "Next" #2).

**`cw hooks install <agent>`** writes the hook entries for the user:

- **Claude Code** — `~/.claude/settings.json`: a `Stop` hook → `cw notify --kind done`
  and a `Notification` hook → `cw notify --kind ask`. Both resolve the session from
  `$CW_SESSION_ID` (src/cli/commands/notify.ts already does), so one entry serves every
  session and pane.
- **Codex / Gemini** — the equivalent config entries their hook systems take, in their
  own config files. Only agents with a hook system on disk get entries; the rest are
  refused with a one-line `CODE:` message (house CLI contract).

Safety (the command edits files outside `~/.crossweave` — settled after review, 2026-10-01):

- **Pre-flight, then atomic write.** Before anything is written, every target file is
  read and parsed; if ANY of them fails to parse (malformed JSON/TOML), the whole
  install aborts for the agents whose files are unreadable — an unparseable file is
  never overwritten, because that would destroy the user's config. Files are written
  atomically: temp file in the same directory, `rename` over the original.
- **Re-read immediately before write** (TOCTOU): the merge is computed from a fresh
  read, not from the pre-flight read; the remaining race with a concurrent writer is
  unfixable without a lock the agent doesn't honour — named in limitations.
- **Backup:** the first time a file is modified, a copy goes to
  `~/.crossweave/hooks-backup/<agent>-<unix-ms>.json` (0600, under `hardenStateFiles`).
- **Provenance lives in `~/.crossweave`**, not in the agent's file: `hooks-installed.json`
  (0600) records per agent which file and which entries crossweave added; `cw hooks
  remove` takes back exactly those. Installing twice is a no-op (idempotent), detected
  both by provenance and by the entry's distinctive `cw notify` command string.
- **All-or-nothing across agents:** pre-flight parses every target file first; a
  failure in file 2 aborts before file 1 is written. Per-agent results are reported.
- It **merges** — never rewrites keys it did not add.
- The entries are printed as a diff and confirmed before writing on a TTY; refused
  without `--yes` when piped.
- Hook commands are limited to the two fixed invocations; nothing user-typed is interpolated.

`$CW_SESSION_ID` in a hook's environment is an assumption to verify, not a fact: a
hook process inherits the agent CLI's environment, which inherits the session shell's
— crossweave sets the variable there — but Phase 2 verifies it live (a hook that
records its own env) before relying on it. `cw notify` gains a **cwd fallback**
regardless: with no `CW_SESSION_ID` and no `--session`, it resolves the session whose
worktree path is an ancestor of the current directory.

## 2. Debug surface — logs shown so they can be acted on

The insight: a failing run is already captured in pieces (check verdict + tail since
schema v18, browser console/network under redaction, agent `latestWords`); what is
missing is one place where a person (or the text they paste to an AI) sees *why it
failed* per session, and a one-click way back into the session.

**Per session, a Debug tab (cockpit) and `cw debug <session>` (CLI)** shows — one
command name, settled 2026-10-01: `cw debug`, resolving the session like `cw check`
and `cw notify` do (`CW_SESSION_ID` / cwd fallback); the daemon RPC is `session.debug`:

- the last `cw check` verdict with its persisted failing tail (≤2000 chars, already in
  `session_check`);
- build/test error lines seen in the session's scrollback stream (daemon-side pattern
  match on coalesced output: `error:`, `FAIL`, compiler diagnostics — a heuristic,
  labelled as one; budget per session: a bounded ring of **50 lines / 8 KB, deduped by
  a normalised key** (numbers and timestamps stripped), in RAM only — not in the
  database, and lost with the daemon, which is honest for debug state);
- the browser pane's console errors + failed network requests — the existing capture
  is already redacted and clipped for BOTH console text and request URLs
  (`src/core/browser-agent/capture.ts`: `clip(redact(text))`, metadata-only network) —
  pulled into the same surface;
- the diff summary (`session diff`, committed + working tree read-only view) — the
  working-tree side is the part today's Changes pane (commits only) misses.

**Redaction of the bundle (settled after review, 2026-10-01).** The bundle is text
the person will paste somewhere else — possibly to an AI outside this machine — so
secrets must not ride along by accident: error lines, the failing tail and latest
words pass a **secret scrubber** (`src/core/redact-secrets.ts`: AWS keys, GitHub
tokens, `sk-…` keys, `Bearer …`, PEM private-key blocks, `user:pass@host` URLs, and
key=value pairs whose key names a secret) before they are shown or printed. It is a
heuristic, not a guarantee, and the UI labels it so; `cw debug --raw` turns it off —
it is the user's own data and their call, but not the default.

**"Send to session"** — from the Debug tab (and the failing-tail dialog): the tail
becomes a composer draft addressed to that session, exact preview before it is typed
into the pane's shell. The person still says everything; the app only carries text
(the command-bridge rule: closed kinds, ask before anything beyond arranging). Note
(decision): a sent prompt counts as the user being present — it clears that
session's `cw notify` word like a keystroke does.

**`cw debug`** — the CLI prints the same bundle as one compact text block for pasting
into any AI. No prompt engineering inside the app; just the facts, labelled.

What is deliberately out: piping logs automatically to a running agent, "smart"
triage/classification, parsing agent-internal debug formats. The app arranges and
carries text; the AI in the session does the debugging.

## 3. Prompt → responses — close the loop after ⌘⇧P

Composer already sends to N sessions; the answers scatter across panes.

- The composer records which sessions it sent to (in memory, per window); the record
  **drops a target as soon as that session leaves `session.list`** (closed, landed,
  removed) — a closed session never lingers in the view.
- A **Responses view** lists those sessions: each row = the session's rail state
  (working / done / asked), its `latestWords` (the agent log's own last words — no new
  channel), and its check chip. Click a row to jump to that session's pane.
- No persistence: the view is worth one working stretch, not a restart.

## 4. Browser pane joins the debug loop

`cw browser` exists (Off/Read/Control per pane, decisions in cockpit main). Two small
additions, reusing what is captured:

- `cw browser errors` / a "Console errors" filter in the pane: console `error` entries
  and failed requests, bounded like the rest (no new capture path).
- The Debug tab pulls the active browser pane's errors into its surface (§2).

Nothing about the pane's permission model changes: Off/Read/Control stays, eval keeps
asking, localhost keeps its cheaper rule.

## 5. Status covers split panes (fixed 2026-10-01, this milestone's base)

An agent typed into an extra Terminal pane was invisible to the rail: only the
session's own pty fed the tracker, and pane shells were outside the `ps` sweep. Fixed
by feeding panes into per-terminal tracks folded into their session's status
(`ActivityTracker.startedTerminal`…, `TerminalObserver`), with the pane shells joining
the agent sweep. Pane exit never marks the session `failed`; typing in any pane of the
session clears its `cw notify` word (the user is present). Notes from review:

- **Precedence (one signal per session):** a `cw notify` word belongs to the SESSION,
  whichever pane spoke it; any pane's keystroke clears it. A pane working never
  downgrades the word; a pane's needs-you outranks a pane working.
- **First frame at 80×24** on purpose: panes open like sessions do (spawn 80×24, the
  client fits and resizes at once — `runtime.ts` does the same); no third size channel
  on `terminal.open`. A CLI attach that never resizes reads a narrow screen — limitation.
- `judge`/`activityOf` mutate while reading (`screenSpoke`, `lastBusyAt`) and now run
  from both `list()` and the sweep — pre-existing behaviour, multiplied by panes; the
  busy-grace window may stretch under frequent redraws. Kept, named in limitations.
- Sweeping cannot announce changes for a session whose own track is missing while a
  pane's activity moves (its `status()` is correct on the next list; the broadcast
  waits for any other invalidate). Rare, named in limitations.

## What stays out of this milestone

- Land gate "only when tests passed" (still 'later'; landing asks when tests failed).
- One-line summaries per session on the rail (depends on §3's groundwork; next).
- Remote/iOS (separate design), terminal flow control (separate measurement first).
