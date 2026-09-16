# crossweave Cockpit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an Electron thin-client cockpit (real xterm panes + attention rail + land from UI) that talks only to `cwd`, so daily use feels Deck-class without forking agent ownership.

**Architecture:** Electron main holds one `DaemonClient` (`connectOrStart`). Renderer gets panes via IPC; each pane is a `session.attach` subscription whose `session.data` chunks are written raw into xterm.js. Rail and land call the same RPCs as CLI (`session.*`, `converge.status`, `land.session`). No app-owned agent PTYs.

**Tech Stack:** Electron (current stable), Vite, Preact + signals (or Preact hooks — pick one and stay consistent), `@xterm/xterm` + fit addon, existing `src/client/rpc-client.ts` / framed JSON-RPC, Bun for daemon/CLI unchanged.

**Spec:** `docs/superpowers/specs/2026-09-16-cockpit-electron-design.md`

## Global Constraints

- App must **not** spawn `claude` / `cursor-agent` / node-pty agents — only daemon RPCs.
- No ANSI stripping on pane bytes — full VT into xterm.
- Land UI must reuse evidence-gate semantics (`ready` / `unknown` / `blocked`, re-fetch after each land) — import or duplicate `chooseNextLand` / land-all loop from `src/cli/commands/land.ts` into a shared pure module if needed (prefer extract to `src/convergence/land-order.ts` or `src/cli/land-all.ts` pure helpers).
- No file explorer, Monaco, browser tabs, analytics in v1.
- No new daemon features except what Windows transport (Task 1) and any tiny attach/subscribe gaps require.
- English UI strings and comments.
- `package.json` root currently `"os": ["darwin", "linux"]` — Windows daemon support is a **gated spike**, not assumed.
- macOS arm64 is the quality bar; Windows ship only after Task 1 verdict allows it.
- Commit after each task.

## File map

| Path | Responsibility |
|---|---|
| `apps/cockpit/package.json` | Electron app package (workspace or standalone) |
| `apps/cockpit/electron/main.ts` | BrowserWindow, IPC, DaemonClient lifecycle |
| `apps/cockpit/electron/preload.ts` | Closed `invoke` / `listen` bridge |
| `apps/cockpit/electron/daemon-bridge.ts` | Wrappers: list/attach/input/resize/land/status/subscribe |
| `apps/cockpit/src/main.tsx` | Renderer boot |
| `apps/cockpit/src/ui/App.tsx` | Shell layout: rail + stage |
| `apps/cockpit/src/ui/AgentRail.tsx` | Session list + attention badges |
| `apps/cockpit/src/ui/Stage.tsx` | Pane grid |
| `apps/cockpit/src/ui/XtermPane.tsx` | One xterm + IPC stream |
| `apps/cockpit/src/lib/attention.ts` | Pure badge derivation from session + converge + events |
| `apps/cockpit/src/lib/land-actions.ts` | Pure land-selected / land-all orchestration helpers (testable) |
| `src/client/rpc-client.ts` | Possibly extend for non-unix transports |
| `src/daemon/server.ts` / `main.ts` | Windows listen path if Task 1 chooses it |
| `src/cli/commands/land.ts` | Extract shared pure helpers if cockpit would otherwise duplicate |

## Scope note

If Task 1 concludes Windows daemon is out of reach for this milestone, **stop Win packaging** and document “macOS-only cockpit v1; Windows follows daemon port” in the spec — do not fake a Win installer that cannot talk to `cwd`.

---

### Task 1: Windows / control-plane transport spike (gate)

**Files:**
- Create: `docs/superpowers/specs/2026-09-16-cockpit-windows-transport-spike.md` (verdict doc)
- Possibly Modify: `src/daemon/main.ts`, `src/daemon/server.ts`, `src/client/rpc-client.ts`, `src/core/paths.ts`
- Test: `tests/client/rpc-client.test.ts` and/or new `tests/daemon/transport-*.test.ts` if code changes

**Interfaces:**
- Produces a written verdict: one of
  - `unix+named-pipe` / `loopback-tcp+token` implemented on daemon+client, or
  - `macOS-only-v1` (Windows deferred) with rationale
- If implementing loopback TCP: `connectOrStart` must still default to unix socket on darwin/linux

- [x] **Step 1: Spike research (no product UI)**

Document in the spike file:
1. Does Bun on Windows support the daemon’s PTY adapter path at all? (If no → `macOS-only-v1`.)
2. Can `node:net` Server listen on `\\.\pipe\...` or `127.0.0.1:port` with a per-workspace token file under `.crossweave/`?
3. Minimal change set to `DaemonClient.connect` + daemon `listen`.

- [x] **Step 2: Decision gate** — **`macOS-only-v1`** (no transport code)

Write the verdict at the top of the spike doc. If `macOS-only-v1`, update cockpit design status note and skip Win packaging tasks later. If transport is chosen, implement **minimal** listen/connect + one round-trip test before any Electron UI.

- [x] **Step 3: If implementing transport — failing test then code** — skipped (verdict = `macOS-only-v1`)

Example test intent: client connects via the new transport, `workspace.info` (or ping method) returns. RED then GREEN.

- [x] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
docs(cockpit): record Windows transport spike verdict

EOF
)"
# plus code commit if transport landed:
# fix(daemon): accept localhost control-plane transport for Windows
```

---

### Task 2: Scaffold `apps/cockpit` (Electron + Vite + Preact + xterm)

**Files:**
- Create: `apps/cockpit/package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`
- Create: `apps/cockpit/electron/main.ts`, `preload.ts` (stubs)
- Create: `apps/cockpit/src/main.tsx`, `src/ui/App.tsx` (hello shell)
- Modify: root README with “Cockpit (dev)” one-liner — only if needed for discoverability
- Test: smoke script or `apps/cockpit` unit placeholder

**Interfaces:**
- Produces: `npm run dev` / `bun run` / documented command that opens an empty Electron window
- Preload exposes **only** `window.cockpit.invoke(channel, payload)` and `window.cockpit.listen(event, cb)` — closed channel allowlist (mirror Deck’s discipline)

- [ ] **Step 1: Scaffold packages**

Use Electron + Vite electron plugin pattern (or `electron-vite`). Pin versions in `apps/cockpit/package.json`. Add `@xterm/xterm`, `@xterm/addon-fit`, `preact`.

- [ ] **Step 2: Empty App layout**

`App.tsx` renders two regions: left rail placeholder, right stage placeholder. No daemon yet.

- [ ] **Step 3: Verify window opens**

Run the documented dev command; manual check OK for this task (automated Electron E2E optional).

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
chore(cockpit): scaffold Electron + Vite + Preact app shell

EOF
)"
```

---

### Task 3: Daemon bridge in Electron main

**Files:**
- Create: `apps/cockpit/electron/daemon-bridge.ts`
- Modify: `apps/cockpit/electron/main.ts`, `preload.ts`
- Create: `apps/cockpit/src/host/cockpit-api.ts` (typed wrappers for renderer)
- Test: unit-test pure channel allowlist; optional integration with fake socket if feasible

**Interfaces:**

```ts
// Channels (snake or dotted — pick one style and keep it)
type CockpitChannel =
  | 'workspace.ensure'      // find project root / init attach workspace id
  | 'session.list'
  | 'session.new'
  | 'session.attach'        // start streaming; returns { sessionId }
  | 'session.detach'
  | 'session.input'
  | 'session.resize'
  | 'session.stop'
  | 'session.kill'
  | 'converge.status'
  | 'land.session';

// Events pushed to renderer
type CockpitEvent =
  | 'session.data'          // { sessionId, chunk: string | Uint8Array base64 }
  | 'tui.event'
  | 'tui.invalidate'
  | 'daemon.gone';
```

Main process:
1. Resolve `projectRoot` (dialog or `process.cwd()` / open-folder on launch — v1: folder picker on first run).
2. `connectOrStart(projectRoot)`.
3. Forward notifications filtered to the renderer.

- [ ] **Step 1: Write allowlist + bridge tests** (pure)
- [ ] **Step 2: Implement bridge**
- [ ] **Step 3: Manual: session.list from DevTools invoke**
- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(cockpit): bridge Electron main to crossweave daemon RPC

EOF
)"
```

---

### Task 4: Single xterm pane attach (E2E fidelity gate)

**Files:**
- Create: `apps/cockpit/src/ui/XtermPane.tsx`
- Modify: `App.tsx` / `Stage.tsx`
- Modify: bridge for attach/input/resize/data
- Test: pure tests for base64/chunk decode helpers if any; manual fidelity checklist

**Interfaces:**
- `XtermPane` props: `{ sessionId: string; focused: boolean }`
- On mount: `invoke('session.attach', { idOrName })` then listen `session.data` for that id
- On keystroke: `session.input`; on container resize: `session.resize` with cols/rows from fit addon

- [ ] **Step 1: Implement XtermPane with fit addon**
- [ ] **Step 2: Wire one hard-coded / selected session**
- [ ] **Step 3: Manual fidelity gate (must pass before Task 5)**

Checklist (record in PR/commit message or `apps/cockpit/README.md`):
1. Start `claude` session via existing `cw` or UI new-session if already wired
2. Pane shows spinner / redraw without spam-lines (contrast M9 failure)
3. Type input reaches agent; resize does not corrupt layout badly

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(cockpit): render a live session in xterm via session.attach

EOF
)"
```

**Stop if fidelity gate fails** — fix attach/streaming before building the rail.

---

### Task 5: Multi-pane stage + Agent Rail

**Files:**
- Create: `apps/cockpit/src/ui/AgentRail.tsx`, `Stage.tsx`
- Create: `apps/cockpit/src/lib/attention.ts`
- Test: `apps/cockpit/src/lib/attention.test.ts` (or under `tests/cockpit/` if monorepo test root preferred)

**Interfaces:**

```ts
export type AttentionKind = 'working' | 'needs_you' | 'blocked' | 'ready' | 'unknown' | 'conflict';

export function deriveAttention(input: {
  status: string;              // session.status
  landability?: 'ready' | 'unknown' | 'blocked';
  recentBlocked?: boolean;     // from tui.event blocked
}): AttentionKind;
```

Priority (document in code): `blocked` > `needs_you` > landability `conflict`/`ready`/`unknown` > `working`.

Rail: click → set focused sessionId; Stage: map open sessions to panes (simple 1–4 grid).  
Actions: New session (prompt name + agent), Stop, Kill (confirm).

- [ ] **Step 1: Failing tests for `deriveAttention`**
- [ ] **Step 2: Implement rail + multi-pane**
- [ ] **Step 3: Subscribe `tui.event` / `tui.invalidate` to refresh list/status**
- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(cockpit): agent rail and multi-pane stage

EOF
)"
```

---

### Task 6: Land selected + Land all from UI

**Files:**
- Create: `apps/cockpit/src/lib/land-actions.ts`
- Modify: chrome/footer buttons in `App.tsx`
- Prefer extract shared pure helpers from CLI:
  - Modify: `src/cli/commands/land.ts` → move `chooseNextLand` (already pure) to `src/convergence/land-order.ts` if not already shared; export land-all loop taking `fetchStatus` / `land` injectables
- Test: `tests/convergence/land-order.test.ts` or cockpit `land-actions.test.ts`

**Interfaces:**

```ts
export async function landSelected(opts: {
  getStatus: () => Promise<ConvergeStatus>;
  land: (name: string, force?: boolean) => Promise<LandResult>;
  name: string;
  forceUnknown?: boolean;
}): Promise<'landed' | 'blocked' | 'needs_confirm_unknown' | 'failed'>;

export async function landAllReady(opts: {
  getStatus: () => Promise<ConvergeStatus>;
  land: (name: string) => Promise<LandResult>;
  onProgress: (name: string, result: LandResult) => void;
}): Promise<{ landed: string[]; failedAt?: string; error?: string }>;
```

UI:
- Disable Land when `blocked`; confirm dialog for `unknown`; Land all only walks `ready` (force-unknown behind explicit checkbox later — v1: no force in UI unless easy)

- [ ] **Step 1: Failing tests for land helpers**
- [ ] **Step 2: Implement + wire buttons**
- [ ] **Step 3: Manual: land all matches `cw land all` on same workspace**
- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(cockpit): land selected and land all via evidence-gated RPC

EOF
)"
```

---

### Task 7: Packaging (macOS arm64 only — Task 1 = `macOS-only-v1`, skip Windows x64)

**Files:**
- Create: `apps/cockpit/electron-builder.yml` (or equivalent)
- Create: CI workflow fragment `.github/workflows/cockpit-release.yml` (optional in-plan; can be follow-up)
- Modify: `apps/cockpit/README.md` — install/run, unsigned Win disclosure

**Interfaces:**
- Produces: local package commands documented
- macOS: arm64 dmg/zip; **no Windows target** (Task 1 = `macOS-only-v1`)

- [ ] **Step 1: electron-builder config for mac arm64**
- [x] **Step 2: Win target only if transport+daemon exist on Win** — skipped (`macOS-only-v1`)
- [ ] **Step 3: Smoke packaged app opens and lists sessions**
- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
build(cockpit): add Electron packaging for daily-use distribution

EOF
)"
```

---

### Task 8: Docs sync + root README pointer

**Files:**
- Modify: `README.md` — short Cockpit section
- Modify: `docs/superpowers/specs/2026-09-16-cockpit-electron-design.md` — Status: Approved / Implemented-in-progress
- Modify: known-limitations digest — cockpit exists; note Win if deferred

- [ ] **Step 1: Edit docs**
- [ ] **Step 2: `bun test` at repo root still green (daemon/CLI unchanged paths)**
- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
docs: point README at Electron cockpit and sync limitations

EOF
)"
```

---

## Spec coverage checklist

| Spec item | Task |
|---|---|
| Electron + xterm thin client | 2–4 |
| No app-owned agents | Global + 3–4 |
| Panes full VT | 4 |
| Rail attention + landability | 5 |
| Land selected / all | 6 |
| macOS only (Windows deferred) | 1 gate (`macOS-only-v1`) + 7 (mac arm64) |
| No explorer/browser | Global |
| Reuse daemon land evidence | 6 |

## Out of scope reminders

- Deck restore / latest-words parity
- Tauri
- Linux cockpit package
- Auto-update for cockpit (follow-up)
- Visual polish pass (post-v1)
