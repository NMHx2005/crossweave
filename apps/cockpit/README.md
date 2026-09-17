# crossweave Cockpit

Electron thin client for `cwd` — real xterm panes, attention rail, land from UI.

**v1:** macOS arm64 only (`macOS-only-v1`). No Windows installer in this milestone — Windows cockpit waits on a portable `cwd` daemon (see `docs/superpowers/specs/2026-09-16-cockpit-windows-transport-spike.md`).

## Dev

From repo root or this directory:

```bash
cd apps/cockpit
bun install
bun run dev
```

Opens Electron, picks a project folder on first run (or uses `COCKPIT_PROJECT_ROOT`), and connects via `connectOrStart`. Skip the picker in later launches if the last folder still exists.

From DevTools:

```js
await window.cockpit.invoke('session.list')
```

## Design system

Chrome colours, density and motion come from one place — `src/ui/tokens.ts` — published
as CSS custom properties at boot (`applyTokens()`) and read by the xterm pane too, so the
pane can never drift from the frame around it. The material is borrowed from the editor
this project is developed in (Cursor + *One Dark Pro Night Flat*: VS Code workbench role
names, that theme's measured values); the anatomy — rail, stage, footer — is crossweave's
own. Rationale, role table and accessibility rules:
`docs/superpowers/specs/2026-09-17-cockpit-design-system.md`.

`tests/tokens.test.ts` enforces it: no literal colours in `app.css`, every `var()` backed
by a token, the pre-paint value in `index.html` matching `--cw-surface`, and every
text/background pair the UI paints measuring ≥ 4.5:1.

## Stage

The stage mounts xterm panes for listed sessions (up to four). **New** creates a session and `session.resume`s it (same as `cw attach --start`) so the pane can attach. Bytes go raw into xterm (no ANSI strip).

## Install (macOS arm64)

Build a local `.dmg` / `.zip` from repo root:

```bash
cd apps/cockpit
bun install
bun run dist:mac
```

Artifacts land in `apps/cockpit/release/` (`crossweave Cockpit-<version>-arm64.dmg` and `.zip`). The app bundles a compiled `cwd` binary under `Contents/Resources/bin/cwd` — no separate Bun install required for the daemon.

Open the app, choose your crossweave project folder (or set `COCKPIT_PROJECT_ROOT` before launch). Unsigned builds: first open may require **System Settings → Privacy & Security → Open Anyway** (or right-click → Open).

## Run packaged build

```bash
open "release/mac-arm64/crossweave Cockpit.app"
# or, with a fixed project:
COCKPIT_PROJECT_ROOT=/path/to/repo open "release/mac-arm64/crossweave Cockpit.app"
```

Smoke after packaging:

```bash
bun run package:smoke
```

## Fidelity gate (Task 4)

M9 nested agents in OpenTUI and stripped CSI; Claude spinners/menus became spam-lines. Cockpit must write `session.data` unchanged (`convertEol: false`, `decodeSessionData` never strips).

| Check | Result (re-run 2026-09-17 against `dist:mac`) |
|---|---|
| 1. Start `claude` via `cw` or UI new-session | **Pass.** A real `claude` 2.1.273 session in a scratch repo rendered in the packaged app's pane — workspace banner, wrapped prose, and the folder-trust menu, all in the pane's own geometry. |
| 2. Spinner / redraw without spam-lines | **Pass.** The menu's box-drawing and wrapping survived intact, and a ↓ keypress came back as a 43-byte in-place redraw (`ESC[1C ESC[1B ❯`) rather than a re-print — the exact M9 failure this gate exists for. |
| 3. Input reaches agent; resize does not corrupt layout | **Pass, measured 2026-09-17 over CDP on the packaged app.** Input: ↓ moved the menu selection through the same `session.input` RPC the app calls, and an Enter delivered to the app's window exited the agent. Resize: viewport 1200×768 → 1000×700 → 1400×900 moved the pane 900 → 700 → 1100px, the xterm re-fitted 877 → 681 → 1080px, and the daemon saw 1242 / 1410 bytes of redraw come back — i.e. the PTY was resized and the agent repainted. `Tab` moves focus into a pane (1px `--cw-accent` outline on xterm's textarea); a further `Tab` stays inside the pane, which is what a terminal does — click to leave it. |

Probe for the attach/encoding half without a GUI: `COCKPIT_PROJECT_ROOT=<repo> bun apps/cockpit/scripts/fidelity-probe.ts`.

## Scripts

| Command | Purpose |
|---|---|
| `bun run dev` | Vite + Electron hot reload |
| `bun run build` | Typecheck + production bundle |
| `bun run dist:mac` | Build `cwd`, bundle app, emit dmg + zip (arm64) |
| `bun run package:smoke` | Verify packaged app + `session.list` |
| `bun test` | Allowlist, daemon-bridge, session-data / fidelity tests |
