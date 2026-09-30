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

The stage holds tabs, each a tree of panes (up to 20 per tab): a session's shell, an extra terminal, a file, a web page, or a session's
Changes. **New** (⌘T) creates a session, or starts a **preset**, and `session.resume`s it (same as `cw attach --start`) so the pane can
attach. Bytes go raw into xterm (no ANSI strip). Panes can be split, zoomed, arranged by preset, moved between tabs, synchronized and
copied from in a vi-style copy mode; `Ctrl-A` (rebindable, unbindable) then one key runs a command.

## Install (macOS arm64)

For releases that include the Cockpit asset, the standard crossweave installer
puts the app at `~/Applications/crossweave Cockpit.app` and installs `cw`/`cwd`
alongside it. Older releases without that asset still install the CLI normally:

```bash
curl -fsSL https://raw.githubusercontent.com/NMHx2005/crossweave/main/install.sh | sh
```

Release pages also carry `cockpit-darwin-arm64.dmg` for manual installation.
The app is not yet notarized, so macOS may require **System Settings → Privacy &
Security → Open Anyway** on first launch. Release checksums protect the downloaded
asset's integrity but do not replace Apple signing/notarization.

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

Both halves are scripted:

- attach/encoding, no GUI needed: `COCKPIT_PROJECT_ROOT=<repo> bun apps/cockpit/scripts/fidelity-probe.ts`
- resize/focus, against a running app: launch it with `--remote-debugging-port=9222`, then
  `COCKPIT_PROJECT_ROOT=<repo> bun apps/cockpit/scripts/fidelity-resize.ts` — it changes the
  viewport, and fails loudly if the xterm stops tracking its pane, if no agent redraw comes
  back from the daemon (that is `session.resize` reaching the PTY), or if `Tab` lands on
  something without a focus ring.

## Checking the UI by hand (what the 2026-09-18 audit covered)

The audit ran against the packaged app with five real Claude sessions, over CDP, and
found four things that unit tests could not see (all fixed in `fix/cockpit-flow-polish`):

| State | How to reach it | What must be true |
|---|---|---|
| Empty | no sessions | `New`/`Stop`/`Kill`/`Start` states are obvious, the stage offers a way forward |
| One live session | `cw session new --name a` | pane attaches, agent TUI renders in full colour |
| Hover / focus a row | mouse over a row, then click it | hover is instant (no fade), the focused row gets the accent bar, its pane border turns accent |
| Many rows, long name | `cw session rename a <44 chars>` | every row is the same height; a long name ellipsises instead of wrapping |
| 3–4 panes | start more sessions | 2×2 grid, panes re-fit, no clipped terminal rows |
| Stopped session | `cw session stop a` | pane says "`a` is not running — start it…", `Start` is enabled and `Stop` disabled; clicking `Start` brings the pane back to life |
| Keyboard | click a pane, then press Tab | focus ring is a 1px accent outline everywhere; Tab stays inside a pane once focus is there (a terminal captures Tab — that is deliberate) |
| Reduced motion | OS setting, or `Emulation.setEmulatedMedia` | every transition collapses to ~0 |

The resize/focus half of the gate stays automated: `bun run fidelity:resize`.

## What the window has, and the script that checks each on the running app

Each script drives the **running** app over CDP and the real daemon. Start the app on a *scratch* `HOME` and repository (never a real
project), then run the script outside a sandbox:

```bash
HOME=/tmp/cwhome COCKPIT_PROJECT_ROOT=/path/to/scratch/repo \
  node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . --remote-debugging-port=9333 --user-data-dir=/tmp/cwud &
HOME=/tmp/cwhome COCKPIT_PROJECT_ROOT=/path/to/scratch/repo bun apps/cockpit/scripts/<script>.ts
```

| Feature | Script | What it proves |
|---|---|---|
| Command bridge | `bridge-check.ts` | a shell command reaches the cockpit and gets its answer; unknown kinds and namespaces are refused |
| `cw pane` | `pane-check.ts` | layout commands change the window; close / sync on / open ask first and do nothing when refused |
| `cw browser` | `browser-check.ts` | off by default, reads redacted and marked untrusted, control needs its level, `eval` always asks, the webview has no Node |
| `cw notify` | `notify-check.ts` | the ✓ and the amber row, the words in the tooltip, cleared by opening or typing |
| `cw check` | `checks-check.ts` | untrusted command refused, ✗ then ✓ on the row, dim when the work moved on |
| Compare | `compare-check.ts` | shared files marked, per-side land buttons, patches open, Escape closes |
| Prompt composer | `prompt-check.ts` | refine only proposes, an agent gets one bracketed paste with no Enter, a plain shell is refused multi-line |
| Presets | `preset-check.ts` | one click: session, extra terminal running its command, browser on the leased port |
| Key-table | `keytable-check.ts` | prefix then key runs a command; prefix twice types the literal |
| Terminal persistence | `persist-check.ts` | with it on, an extra terminal survives a daemon restart; off, nothing does |
| Settings | `settings-check.ts` | search, sections, save |
| Motion / speed | `motion-check.ts`, `bench-terminal.ts` | FLIP and fades; output coalescing and the WebGL budget |

`prompt-check.ts` and `preset-check.ts` need a settings file written *before* the app starts (their headers say what goes in it).
If a daemon from an earlier run is still alive for the scratch repository, it keeps answering with old code: stop it (its cwd is the
scratch repo) before a run that depends on a new daemon method.

## Scripts

| Command | Purpose |
|---|---|
| `bun run dev` | Vite + Electron hot reload |
| `bun run build` | Typecheck + production bundle |
| `bun run dist:mac` | Build `cwd`, bundle app, emit dmg + zip (arm64) |
| `bun run package:smoke` | Verify packaged app + `session.list` |
| `bun run fidelity:resize` | Viewport→pane→fit→PTY resize plus the keyboard focus ring, against a running app (see the gate above) |
| `bun test` | Allowlist, daemon-bridge, session-data / fidelity tests, token guards |
