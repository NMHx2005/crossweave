# crossweave Cockpit — Electron Thin Client (Design)

**Date:** 2026-09-16  
**Status:** Draft for review  
**Approach:** Thin Electron over daemon (Approach 1)  
**Depends on:** Land & Lease Reliability (shipped) — evidence-gated land, honest leases

---

## 1. Goals and scope

### Why this exists

Land/lease moat is on `main`, but daily use stalls when the surface feels like “CLI + thin TUI” next to products like SpaceVibe Deck. Nesting agents inside OpenTUI with ANSI stripping was measured and rejected (M9). The cockpit is the daily-use shell: real PTY panes + attention rail + land from UI, still driven by `cwd`.

### Daily-use bar (locked)

| Need | In v1? |
|---|---|
| Real multi-pane PTY (agent UIs readable) | Yes |
| Attention rail (working / needs-you / blocked / landability) | Yes |
| Land selected / land all from UI | Yes |
| Desktop polish (typography, chrome, motion) | After v1 — does not block ship |
| File explorer / editor / browser tabs (Deck parity) | No |

### Locked decisions

| Decision | Choice |
|---|---|
| Shell | Electron + xterm.js |
| Platforms v1 | macOS + Windows |
| Architecture | Thin client → daemon JSON-RPC; app does **not** spawn agents |
| MVP cut | Panes + rail + land (not explorer/editor/browser) |
| CLI | `cw` / `cwd` remain first-class; cockpit is another client |

### Success criteria

- Open the app → 2–4 Claude/Cursor sessions in real xterm panes (spinners/menus readable)
- Rail reflects working / needs-you / blocked / ready|unknown|conflict from daemon signals
- Land selected / land all use the same evidence gate and re-fetch semantics as CLI
- New / stop / kill session from UI
- macOS arm64 is the quality bar; Windows x64 has at least attach + land smoke (unsigned OK if disclosed)

### Non-goals (v1)

- Cloning Deck’s full product surface
- Tauri
- App-owned node-pty agent processes
- Always-on analytics
- Linux cockpit (may follow; daemon already targets Linux CLI)
- Rewriting Safe Mode / Bash interception
- OpenTUI multi-pane (M9 path abandoned for interactive agents)

---

## 2. Architecture

```
┌──────────── Electron app ────────────┐
│  Renderer: UI + xterm.js panes       │
│    rail │ stage │ land actions       │
│           │ IPC (invoke / listen)    │
│  Main: thin host                     │
│    • connectOrStart cwd              │
│    • session.attach / input / resize │
│    • converge.status / land.*        │
│    • daemon.subscribe (tui.*)        │
└──────────────┬───────────────────────┘
               │ JSON-RPC control plane
               ▼
            cwd — sole state owner (unchanged)
```

### Rules

1. **Daemon owns agents.** Worktrees, leases, radar, Safe Mode, land — all stay in `cwd`. The cockpit never `spawn`s `claude` / `cursor-agent` itself.
2. **Pane = attach subscription.** Bytes from `session.attach` / `session.data` go straight into xterm (no strip-ANSI). Input and resize use existing RPCs. Closing a pane unsubscribes; the agent keeps running.
3. **One daemon connection, many attaches** — reuse the existing multi-subscriber runtime pattern.
4. **Rail + land read the same SoT** as CLI: session list, `tui.event` / `tui.invalidate`, `converge.status` (`ready` / `unknown` / `blocked`).

### Windows control plane (ship gate)

Today’s daemon socket story is POSIX-first. v1 Windows requires an explicit transport spike before claiming parity:

- Prefer a localhost-only channel with auth (named pipe or loopback TCP + token), not an open remote port
- macOS keeps unix domain sockets
- UI design does not block on this; **shipping Windows installers does**

### Repo layout (intent)

- Electron app under something like `apps/cockpit/` or `desktop/` in-repo
- Reuse or thin-wrap `src/client` RPC client from main process
- Existing `bun` build for `cw` / `cwd` unchanged

---

## 3. UI surfaces (v1)

### Layout

- **Left — Agent Rail:** sessions (name, agent, Safe Mode tier, short spend). Attention badge:
  - `working` — running, not waiting on the user
  - `needs you` — waiting / permission / prompt (from session status and available hook/ACP signals; opaque PTY may be weaker)
  - `blocked` — radar / Safe Mode block events
  - landability — `ready` / `unknown` / `conflict` from `converge.status`
- **Right — Stage:** split xterm panes; rail click focuses the matching pane
- **Chrome / footer:** New session, Land selected, Land all (ready), Stop/Kill — confirm destructive actions

### Pane behavior

- Full VT via attach stream (scrollback as today’s attach)
- Minimal splits for 2–4 panes; no Deck-style layout presets in v1
- One session ↔ one pane

### Land UX

- **Land selected:** enable when `ready`; confirm+warn when `unknown`; disable+reason when `blocked`
- **Land all:** same re-fetch loop as CLI; show per-session progress; stop with a single clear error
- Compact status/matrix in rail or drawer — not a DAG canvas

### Deliberate differences from Deck

- Rail emphasizes **landability and collisions**, not only “latest words”
- No file explorer, Monaco, or browser tabs in v1

### Polish (post-v1)

- Typography, theme, window chrome, light motion — after the daily-use bar is met

---

## 4. Build order, acceptance, risks

### Suggested implementation slices

1. Windows control-plane spike (gate for Win claim)
2. Electron shell + RPC: connectOrStart, session list, single xterm attach E2E
3. Multi-pane + rail badges
4. Land selected / land all + confirms
5. Packaging: macOS arm64 + Windows x64 (disclose unsigned Win if needed)

### Acceptance checklist

1. 2–4 real agent sessions readable in panes
2. Rail blocked / ready-to-land matches daemon
3. Land actions match CLI evidence semantics (no bypass)
4. New / stop / kill from UI
5. macOS arm64 solid; Win x64 smoke for attach + land

### Accepted risks

- Electron is heavier than CLI — traded for fidelity
- Windows transport may lag macOS quality initially
- `needs you` quality depends on agent signals
- No Deck feature parity

### Relationship to prior work

- Consumes Land & Lease Reliability (`classifyLandability`, land-all re-fetch, lease visibility)
- Supersedes M9 interactive OpenTUI panes for agent interaction
- Phase gate from the land/lease design (“use as habit before desktop”) is **revised**: UI quality was blocking habit; cockpit proceeds now with weft already on main

---

## 5. Open items for the implementation plan (not unresolved product questions)

- Exact Electron/Preact (or React) stack versions and packaging toolchain
- Whether `needs you` v1 is status-only or also parses ACP/hook events
- Final path for Windows IPC
- Auto-update for the cockpit binary (may follow CLI `cw update` patterns later)
