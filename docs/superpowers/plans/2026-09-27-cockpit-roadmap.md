# Plan — cockpit roadmap (user's picks, 2026-09-27)

Branch: `feat/cockpit-roadmap` (one branch per phase if a phase grows).
Backlog source: memory `cockpit-feature-ideas`. The user chose items 1, 2, 3, 4, 9, 11,
12, the tmux-like panes, and remote/phone access — nothing else from that list.

Every phase ends with the gate (root typecheck · `bun test --max-concurrency=1` ·
`bun run build` · cockpit `bun test` + `bun run build`), a look at the running app
(CDP / screenshot, temp `HOME` whenever Settings are written), a known-limitations file
+ digest line, and a report to the user **before** the next phase starts.

---

## Phase A — the stage and the agents (items 1, 2, 4, 3)

### A1. Tabs stay live (item 1)
Today `Stage` renders only the active tab's tree, so switching tabs unmounts every pane
and re-attaches (replay) on return. Render every tab's tree, the inactive ones
`display:none`, exactly as live project views do; XtermPane already skips fitting at
0×0 and refits when shown (ResizeObserver).
- `Stage.tsx`: one `.cockpit-stage__body` per tab, `hidden` unless active.
- Focus: a pane's `focused` also requires its tab to be active (as `shown` does for views).
- Cost: every open tab's terminals stay in memory (bounded by the user's own tabs).
- Test: layout-level test that the rendered tree set = all tabs (pure helper
  `renderedTabs(stage)`); CDP: same xterm element before/after a tab round trip,
  output printed while hidden is there.

### A2. Find in terminal — ⌘F (item 2)
- Dependency: `@xterm/addon-search` (pure JS, released with xterm 6.0.0 — verify version
  pairing and no install scripts, as for unicode11).
- Each XtermPane loads the addon; a find bar overlays the pane's top-right: input,
  match count, ↑ ↓, case / regex / whole-word toggles, Esc closes and refocuses the
  terminal. Matches highlighted with the selection token colors (decorations need
  `allowProposedApi`, already on).
- Commands: menu Edit → Find ⌘F, Find Next ⌘G, Find Previous ⌘⇧G → host → active view
  → the focused pane (a view-level event the focused XtermPane listens to).
- Tests: pure find-bar state reducer (open/close/next/prev/options); menu test for the
  three accelerators; CDP: print known text, ⌘F-equivalent, count of matches.

### A3. Notify when an agent finishes (item 4)
- `newlyFinished(prev, next)` beside `newlyAsking`: a running session whose activity
  went `working → idle` (the agent stopped producing and did not ask). Tested for:
  asked is not finished, stopped shells are not, first sight is not, flapping within
  one sweep is not.
- Notification "<name> finished" with the agent's latest words; click focuses the session
  (and its project). Shown when the window is not focused or the project/tab is hidden.
- Settings → "When a session waits for you" becomes "Notifications": waits (existing),
  finishes (new, on by default), sound, Dock count.
- Rail: a finished-and-unseen session keeps a small "done" mark until focused.

### A4. Tokens and cost per session and project (item 3)
- Daemon `src/domain/agent-usage.ts` (beside agent-logs): per worktree,
  - Claude Code: sum `message.usage` over assistant entries, **deduplicated by
    `message.id`** (one message spans several lines), per model: input, output,
    cache-write, cache-read.
  - Codex: the last `token_count.info.total_token_usage` of each rollout whose
    `session_meta.cwd` is the worktree, model from `turn_context`.
  - Only logs written since the session was created (a shared session's folder has
    older conversations); tail-read with a size cap; best effort, never an error.
  - Cached per session by file size+mtime; refreshed with the git counts' throttle.
- `session.list` gains `usage: { tokens: {in, out, cacheWrite, cacheRead}, byModel }`.
- **Cost:** the logs carry no price, and prices change — no built-in price list.
  Settings → Usage: a price per model (USD per million tokens, per kind), empty by
  default; cost shows only for models with a price, labelled as an estimate.
- Rail: a compact figure on each row (e.g. `1.2M` or `$4.10`), the project total in the
  heading, details in the tooltip; toggled in Settings.
- Tests: fixtures in the real line shapes (duplicated message ids, cache fields, Codex
  cumulative totals, a log older than the session), price application, formatting.

---

## Phase B — sessions and the keyboard (items 9, 12, tmux panes)

### B1. A note per session (item 9)
- One line per session, stored with the session in the daemon (a `note` column —
  forward-only migration) so the CLI and every window see it; `session.note` RPC with
  validation (one line, ≤120 chars); `cw session note <name> "…"`.
- Rail: the note replaces the agent's latest words when set (tooltip keeps both);
  right-click → "Set note…" (inline edit, as rename); Clear note.
- Tests: migration, repository, RPC validation, CLI, rail title choice.

### B2. Rebindable shortcuts + a shortcut list (item 12)
- `keybindings` in settings: command id → Electron accelerator, validated against a
  closed list of commands and accelerator grammar; conflicts refused with the name of
  the other command.
- The main process builds the menu from defaults + overrides and rebuilds it when
  settings change (a `settings.changed` broadcast from the daemon, or on Save).
- Settings → Keyboard: every command with its shortcut, a recorder (press the keys),
  reset per command / all. Help → Keyboard Shortcuts (⌘/) shows the same list read-only.
- Tests: accelerator validation, conflict detection, menu template with overrides.

### B3. tmux-like panes
Pure layout functions (`layout.ts`), each tested:
- `swapPanes`, `movePane(from, toPane, side)` — drag a pane by its drag handle (a
  small grip on hover, or Option-drag) onto another pane's edge/centre.
- `zoomPane` — one pane fills the tab until toggled (⌘⇧↩, as tmux `z`); zoom is view
  state, not saved in layouts.
- `neighbourPane(tab, paneId, direction)` — focus with ⌘⌥←↑→↓.
- `equalize(split)` and presets: even-horizontal, even-vertical, main-left, tiled.
- `paneToTab` / `tabIntoPane` (break out, join).
- Menu: View → Pane → each of the above with shortcuts (rebindable through B2).
- CDP: drag-swap, zoom round trip, focus moves, presets on four panes.

---

## Phase C — app theme (item 11)

- Theme = a full token set. Keep "Dark" (today). Add "Light" — a curated set (One Light
  family, as Dark is One Dark) — and "From terminal": chrome tokens derived from the
  imported terminal colors (background → surface, foreground → text, blue → accent,
  palette → attention roles), each derived pair checked for WCAG AA and nudged toward
  contrast until it passes; "System" follows macOS appearance.
- `tokens.ts` exports every set; `tokens.test.ts` runs every contrast assertion for
  **each** set (the derived one against the imported fixtures), keeps the literal-free
  CSS guarantees. `applyTokens(set)` at boot and on change; `color-scheme` follows.
- xterm default theme follows the app theme unless terminal colors were imported.
- Settings → Appearance: Theme (System / Dark / Light / From terminal), live preview.

---

## Phase D — remote / phone access (security-sensitive; design needs the user's OK)

What exists: a WebSocket gateway to the daemon with read/control tokens, an Origin
check, a built-in web page, E2E sealing of `session.data`, and a relay design.

Proposed shape (to confirm before code):
- **Reach:** over the user's own private network only — Tailscale (or the LAN), not the
  public internet; the gateway binds to the Tailscale/LAN address the user picks, never
  0.0.0.0 by default. A hosted relay stays out of scope.
- **Pairing:** Settings → Remote shows a QR code (URL + one-time pairing code); the phone
  exchanges it for a device token (revocable per device, listed with last seen).
  Read-only by default; control (typing, answering) is a separate toggle per device.
- **Phone UI:** the gateway's web page made mobile-first: projects → sessions with
  status and latest words, live output of one session, an answer box and quick keys
  (Enter, Esc, ↑/↓, y/n) for a session that asks; push-free (the page polls/streams
  while open).
- **Security review:** threat model (token theft, CSRF/Origin, replay, brute force of
  pairing codes, what a read token reveals), rate limits, expiry, audit of methods
  allowed per token kind; `/security-review` on the diff before merge.
- Decisions for the user: Tailscale vs LAN; control from phone on/off by default;
  whether the cockpit runs the gateway or `cw gateway serve` does.

---

## Order and reporting

A → report → B → report → C → report → D design → **user's OK** → D build → security
review → report. Each item is its own commit (Conventional Commits, what + why).

## Phase D outcome (2026-09-27)

Phase D (phone access from a browser, over Tailscale / Wi-Fi) was built, reviewed and
then removed at the user's request: remote control will be a native iOS app instead.
The work is kept at tag `v0.4-remote-web`; the old `cw gateway` went with it. Kept on
this branch: `session.list` reports each running session's pty size, and re-attaching
a connection no longer stacks close handlers in the daemon.

