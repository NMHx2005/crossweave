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

| Check | Result |
|---|---|
| 1. Start `claude` via `cw` or UI new-session | **Partial.** Live `cwd` on the main repo had `daemon.sock` but `cw session list` was empty. Did not spawn `claude`. Pane attaches list-first once a running session exists. |
| 2. Spinner / redraw without spam-lines | **Pass (probe).** PTY `printf` of `ESC[2K ESC[1G⠋ Thinking…` survives `encodeSessionData` → `decodeSessionData`; CSI still present. A strip-ANSI path would drop the overwrite sequences (M9). GUI eyeball of a real Claude spinner was not available. |
| 3. Input reaches agent; resize does not corrupt layout | **Wired, not GUI-exercised.** Keystrokes → `session.input`. Fit addon + `ResizeObserver` → `session.resize` only when cols/rows change. |

Limits: no real Claude GUI this run. Re-check 2–3 visually after `cw session start` + `COCKPIT_PROJECT_ROOT=<repo> bun run dev`. Probe: `COCKPIT_PROJECT_ROOT=<repo> bun apps/cockpit/scripts/fidelity-probe.ts`.

## Scripts

| Command | Purpose |
|---|---|
| `bun run dev` | Vite + Electron hot reload |
| `bun run build` | Typecheck + production bundle |
| `bun run dist:mac` | Build `cwd`, bundle app, emit dmg + zip (arm64) |
| `bun run package:smoke` | Verify packaged app + `session.list` |
| `bun test` | Allowlist, daemon-bridge, session-data / fidelity tests |
