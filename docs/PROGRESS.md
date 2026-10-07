# Progress — crossweave

**Last updated:** 2026-10-08
**Product:** `cw` (CLI), `cwd` (daemon) and the Electron **Cockpit** run N parallel sessions on one repository and land them
back. A session is a git worktree plus the user's shell in it; what runs there is the user's to type.
**Where the known gaps are:** `docs/superpowers/specs/2026-08-14-known-limitations-digest.md` (one line per milestone, newest
last) and the `*-known-limitations.md` next to each spec.

## Built and on `main`

### Engine (`cwd`, `cw`)

| Area | What it does | Notes |
|---|---|---|
| Workspaces and sessions | `cw init`, `cw session new/start/stop/attach/list/path/rename/note/kill/rm`, plain (non-git) folders | schema is at **v18**; migrations are append-only |
| Isolation | per-session port block (`$PORT`), cache dir, optional DB/Docker names, disk guard | leases are cooperative, not a sandbox |
| Convergence | background trial merges, conflict graph, recommended order, `cw land`, `cw land all`, pre-land test command (`cw config trust`) | evidence-gated |
| Status | what a session is doing is inferred from its shell (screen words, output, bell, process tree) | reliable for Claude Code, Codex, Gemini; approximate for the rest |
| **`cw notify`** (2026-09-30) | a session or its agent's hook says it is done or needs an answer; exact where the screen is a guess | `2026-09-30-cw-notify-known-limitations.md` |
| **`cw check`** (2026-09-30) | the trusted `converge.testCommand` run in one session's worktree; verdict on the rail | `2026-09-30-session-checks-known-limitations.md` |
| **Command bridge** (2026-09-29) | a shell command asks the running cockpit to do something, through the daemon; closed namespaces, first come first served | `2026-09-29-cockpit-command-bridge-known-limitations.md` |
| **`cw pane`** (2026-09-29) | arrange the running cockpit's panes from a shell; it asks the person before anything more than layout | `2026-09-29-cockpit-pane-bridge-known-limitations.md` |
| **`cw browser`** (2026-09-30) | an agent reads and drives a Browser pane (console, network, dom, screenshot, navigate, click, type, eval) behind a per-pane Off/Read/Control switch | `2026-09-30-cockpit-browser-agent-known-limitations.md` |
| **AI debug loop** (2026-10-01, unreleased) | `cw hooks install\|remove <claude\|codex>` wires an agent's own hooks to `cw notify`; `cw debug` prints one scrubbed bundle (check tail, error lines, diffstat, latest words) to paste to an AI; `cw browser errors` | `2026-10-01-ai-debug-loop-known-limitations.md` |
| Terminal persistence (2026-09-29) | opt-in: extra terminals reopen after a daemon restart | off by default |
| Session history (2026-09-28) | `cw session history`; survives deleting the session | `2026-09-28-session-history-known-limitations.md` |
| Setup-hook exit code (2026-09-28) | a failed `hooks.sessionSetup` shows on the rail | `2026-09-28-session-setup-exit-code-known-limitations.md` |
| Distribution | `install.sh`, `cw update`, release workflow | app is signed with a development certificate, **not notarized** |

### Cockpit (macOS arm64)

Rail of projects and sessions with live status; tabs of shells, files, web pages and Changes; tmux-style panes (zoom, focus by
direction, presets, swap, pane → tab, synchronize, copy-mode, a `Ctrl-A` key-table); Settings page like Cursor's; terminal speed
(WebGL under a budget, output coalescing) and motion; file drops become paths; launchers; project tools; themes; notifications;
usage per session; its own app icon (`apps/cockpit/build/icon.svg`, four warp threads in the agents' colours crossed by a weft); and, new on 2026-09-30:

| Feature | Where |
|---|---|
| Prompt composer (⌘⇧P, pen button): write once, optional **Refine** by your own command, send to several sessions | `2026-09-30-prompt-composer-known-limitations.md` |
| Compare two sessions side by side and land one | `2026-09-30-session-compare-known-limitations.md` |
| Session **presets**: one click starts a session, its terminals (each running a command) and a browser on its port | `2026-09-30-session-presets-known-limitations.md` |
| Session history dialog (⌘⇧H) | `2026-09-28-session-history-known-limitations.md` |
| Status marks: loading ring while an agent works, ✓ until you look at a finished one, nothing for a quiet shell | this file's changelog below |
| Rail keeps the newest answer (out-of-order loads are dropped); typing no longer counts as work; landing asks when the tests last failed | `docs/releases/v0.4.0.md` |
| **Debug pane** (session menu → Debug) and **Responses** view (⌘⇧R) after a composer send, status that covers split panes, a live drag preview (2026-10-01, unreleased) | `2026-10-01-ai-debug-loop-known-limitations.md` |
| **Settings redesigned after Cursor's** and a **Dashboard** (projects, sessions, disk, memory; proposals to clean up, delete or stop idle work — always asks first) | `2026-09-30-settings-dashboard-known-limitations.md` |

## Removed on purpose (do not reintroduce)

| Date | What | Last version with it |
|---|---|---|
| 2026-09-27 | collision guard, tiers / Safe Mode, agent adapters and launch flags, MCP server, OS sandbox | tag `v0.3-radar` |
| 2026-09-27 | `cw gateway` and the phone web page (browser remote control) | tag `v0.4-remote-web` |
| 2026-09-30 | in-app voice input (dictation is left to a system-wide tool such as Handy or Superwhisper) | tag `v0.5-voice-input` |

## Next

1. **0.5.0 is tagged**; the owner restarts the app and, when no session is mid-task, the project daemons (that ends running
   sessions) so the Dashboard has numbers for existing projects.
2. Use it for a week and fix what is annoying: run `cw hooks install claude` and try the debug loop, presets and the composer for real.
   `$CW_SESSION_ID` plus `CW_WORKSPACE_ROOT` now reaches `cw notify` from a restarted session shell and the owning daemon records its signal;
   the running app showed the status-source/age tooltip, a populated Responses row and the Debug pane's localhost browser errors; Browser access was restored to Off. Real-world capacity still awaits a week of owner usage.
3. Notarize the app (needs the owner's Apple Developer account and a hardened-runtime pass; the app has its own icon since 0.4.0 but is still signed only with a development certificate).
4. **Auto-update (owner's word, 2026-10-01: after the Apple Developer account exists).** (a) The corner notice for a newer
   `vX.Y.Z` release is **built** (2026-10-08, `2026-10-08-hardening-round-2-known-limitations.md`); (b) real "Restart to update"
   needs a notarized, properly signed app, so it waits for item 3.
5. Later: a native iOS app for remote control (designed from scratch), a Linux cockpit, per-session one-line summaries on the rail,
   an optional "land only when the tests passed" gate.

## Changelog (newest first)

- **2026-10-08 (round 2)** — `✗ setup` chip; history filter and a 500-row cap; more `cw debug` error shapes and token shapes;
  opt-in `converge.requireCheck` (+ `cw land --skip-check`); `cw check` runs with the session's lease env; Compare shows the pair's trial merge;
  Refine can be cancelled; update notice; the renderer's first load is ~274 kB (editor loaded lazily); `cw daemon stop` e2e tests.

- **2026-10-07/08** — session-shell CLI routing back to its owning daemon; status-source and event-age tooltip; two-worktree README quickstart; live verification of `cw notify`, populated Responses, and the Debug Browser section with Read returned to Off.
- **2026-10-01** — AI debug loop on `main` (unreleased): `cw hooks`, `cw debug`, Debug pane with send-to-session, Responses view,
  `cw browser errors`; status now covers split panes; panes drag with a live preview.
- **2026-09-30 (later)** — Cursor-style Settings and the resource Dashboard (`DiskTracker`, `stats.overview`), Search box with icon,
  rail frame no longer shifts on switch, CI runs the cockpit's view test on macOS; version 0.5.0.
- **2026-09-30** — `cw notify`, `cw check`, compare, prompt composer, presets, session history, setup exit-code, hooks review
  fixes, rail/status polish; voice removed; version 0.4.0 prepared.
- **2026-09-29** — command bridge, tmux parity (commands, panes, key-table, terminal persistence, `cw pane`), browser-agent
  access, settings page, terminal speed, motion, daemon lifecycle.
- **2026-09-27** — collision guard and agent model removed; browser remote removed; cockpit roadmap (notifications, usage, ⌘F,
  notes, shortcuts, themes, panes).
- **2026-09-17 … 2026-09-24** — cockpit design system, launchers, live projects, plain folders, project tools; the earlier
  Deck-bridge / gateway horizons (later removed).
- **2026-08-10 … 2026-08-14** — engine milestones M1–M9: workspaces, worktrees, leases, convergence, land, notifications, TUI.

## How to verify

```bash
bun run typecheck                      # tsc --noEmit (src/ and tests/; the cockpit typechecks in its own build)
bun test --max-concurrency=1           # root suite (includes the cockpit's tests); outside a sandbox for pty and socket tests
bun run build                          # dist/cw, dist/cwd
cd apps/cockpit && bun test && bun run build
```

Each feature also has a script under `apps/cockpit/scripts/` that exercises it on the **running app** over CDP (see
`apps/cockpit/README.md`); they are run on a scratch `HOME` and repository, never on real projects.

`main` stays linear (fast-forward merges).
