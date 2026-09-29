# Plan — browser agent access

Spec: `docs/superpowers/specs/2026-09-29-cockpit-browser-agent-access-design.md`
Branch: `feat/browser-agent`
Tier: Large — a security-shaped feature (page content reaches an agent, an agent drives a page); pure core, a
main-process CDP driver, a renderer switch, a CLI, a security matrix.

## Deviations from the spec, decided while reading the code

- A Browser pane has **no session** in this codebase (`PaneRef` `browser` carries only a url), so "the caller's
  session" cannot scope `list` or the default pane. The scope is the **caller's project** (the bridge already
  routes a call to one workspace): the default pane is the only Browser pane of that project, and `--pane` takes a
  pane id. `CW_SESSION_ID` is not used.
- The renderer also tells main the pane's `projectRoot` at registration, so a pane of another open project is
  never addressable from this project's shell.
- A debugger `detach` (the person opened DevTools, the page crashed) is pushed on the existing `browser.activity`
  event as `command: 'detached'`, so the switch shows `off` again without a third channel.

## Tasks

1. [x] **Pure core** `src/core/browser-agent/`: `permission.ts` (command × level, confirm rule), `origin.ts`
   (local classification), `redact.ts`, `ring.ts`, `capture.ts` (CDP events → bounded console/network buffers,
   cleared on origin change), `query.ts` (filters and limits). Tests first in `tests/core/browser-agent/`.
2. [x] **Main driver** `apps/cockpit/electron/browser-agent.ts`: registry `paneId → {projectRoot, webContentsId,
   level}`, lazy refcounted attach, the nine commands over CDP, native confirmation (serialised, 20 s = refusal),
   live-origin read at execution, screenshots written by main. Tests with a fake debugger first.
3. [x] **Wiring**: `browser.setAccess` channel + `browser.activity` event, `browser.*` kinds on the command bridge,
   webview-guest validation, `hardenWebviews` untouched (test asserts it).
4. [x] **Renderer**: the three-level switch, badge and activity line in `BrowserPane`.
5. [x] **CLI** `cw browser …` (`src/cli/commands/browser.ts`), `tests/cli/browser.test.ts`.
6. [x] **End to end** with `scripts/browser-check.ts` on the running app (real webview, real CDP).
7. [x] **Docs**: known-limitations file + digest line.

## Gate

`bun run typecheck` · `bun test --max-concurrency=1` · `bun run build` · cockpit `bun test` + `bun run build` ·
the end-to-end script.
