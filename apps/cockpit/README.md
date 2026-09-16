# crossweave Cockpit

Electron thin client for `cwd` — real xterm panes, attention rail, land from UI.

**v1:** macOS arm64 only (`macOS-only-v1`).

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

The stage mounts **one** xterm pane on the first listed session (picker in the header). Start the agent with `cw` first — `session.attach` requires a running PTY. Bytes go raw into xterm (no ANSI strip).

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
| `bun test` | Allowlist, daemon-bridge, session-data / fidelity tests |
