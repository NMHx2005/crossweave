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

Opens an empty Electron window (left rail + stage placeholders). Preload exposes only closed `window.cockpit.invoke` / `window.cockpit.listen` stubs until Task 3 wires the daemon bridge.

## Scripts

| Command | Purpose |
|---|---|
| `bun run dev` | Vite + Electron hot reload |
| `bun run build` | Typecheck + production bundle |
| `bun test` | Allowlist unit tests |
