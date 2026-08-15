import { defineCommand } from 'citty';
import {
  createCliRenderer,
  BoxRenderable,
  CliRenderEvents,
  InputRenderable,
  InputRenderableEvents,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type Renderable,
  type SelectOption,
} from '@opentui/core';
import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';
import type { Binding } from '@opentui/keymap';
import { findProjectRoot } from '../../core/paths.js';
import { loadConfig } from '../../core/config.js';
import { connectOrStart, type DaemonClient } from '../../client/rpc-client.js';
import { fail } from '../context.js';
import type { SessionRow } from '../../db/repositories/session.js';
import { humanBytes } from '../../isolation/disk-guard.js';
import { format, type NotifyEvent } from '../../notify/dispatcher.js';

interface WorkspaceInit { id: string; name: string }
interface Workspace { id: string; name: string; rootPath: string; safeModeTier: string }
interface DiskInfo { usedBytes: number; limitBytes: number }
// `disk` is an RPC-layer enrichment (see 'workspace.info' in src/daemon/methods.ts) —
// `WorkspaceManager.info()` itself still only returns `{workspace, sessions}`.
interface WorkspaceInfo { workspace: Workspace; sessions: SessionRow[]; disk: DiskInfo }
interface ConvergeStatus {
  pairwise: { a: string; b: string; result: string }[];
  fullIntegration: { result: string; ts: string; detail: string | null } | null;
  recommendedOrder: string[];
  // The RPC handler (src/daemon/methods.ts 'converge.status') has always returned
  // this — the degree-0 subset of `recommendedOrder`, i.e. sessions with no known
  // conflict. Not declared here until now because nothing in this file read it;
  // land-all (Task 7) is that first reader.
  conflictFree: string[];
  degraded: boolean;
}

// Populated by the initial fetch in `run()` below and read by the panes Tasks 4-6
// add (session list, convergence matrix, workspace/budget info).
let latestSessions: SessionRow[] = [];
let latestConvergeStatus: ConvergeStatus | null = null;
let latestWorkspaceInfo: WorkspaceInfo | null = null;

// Unlike the three `latestX` above, this isn't refetched by `refresh()` — it only
// ever grows from live `'tui.event'` notifications (see `appendFeedLine` below).
// Kept module-level (not just on the pane) for the same reason `latestSessions`
// etc. are: `'tui.event'` notifications can arrive before `feedPane` is mounted
// (the gap between `daemon.subscribe` and `createCliRenderer` below), so the text
// must survive until the pane exists to read it.
const FEED_MAX_LINES = 200;
let latestFeedLines: string[] = [];

/**
 * Pure data → string formatting, kept separate from the OpenTUI wiring below so it
 * is unit-testable without a real terminal (see tests/cli/tui-panes.test.ts).
 *
 * Dot mapping follows the same live/idle/terminal grouping already used elsewhere
 * in the domain layer (src/domain/bus.ts groups 'running'+'waiting' as live;
 * src/domain/gc.ts and src/domain/session.ts group 'dead'+'landed' as terminal),
 * not an invented one.
 */
export function formatSessionRow(row: SessionRow): { text: string; dot: '●' | '○' | '✕' } {
  const dot: '●' | '○' | '✕' =
    row.status === 'running' || row.status === 'waiting' ? '●' :
    row.status === 'dead' || row.status === 'landed' ? '✕' : '○';
  const text = `${row.name}  ${row.status}  ${row.enforcementTier}  $${row.costSpentUsd.toFixed(2)}`;
  return { text, dot };
}

/**
 * `disk` comes from `workspace.info`'s RPC-layer enrichment (src/daemon/methods.ts),
 * backed by `measureWorktrees` (M1's Disk Guard, src/isolation/disk-guard.ts) —
 * `WorkspaceManager.info()` itself doesn't carry it, only the RPC response does.
 */
export function formatStatusBar(
  ws: { name: string },
  sessions: SessionRow[],
  disk: { usedBytes: number; limitBytes: number },
): string {
  const totalCost = sessions.reduce((sum, s) => sum + s.costSpentUsd, 0);
  const count = sessions.length;
  return (
    `${ws.name}  |  ${count} session${count === 1 ? '' : 's'}  |  ` +
    `$${totalCost.toFixed(2)} spent  |  disk ${humanBytes(disk.usedBytes)}/${humanBytes(disk.limitBytes)}`
  );
}

/**
 * `converge.status`'s `pairwise` entries carry branch names (`trial.branches`,
 * see the `'converge.status'` handler in src/daemon/methods.ts), not session
 * names — the RPC never resolves them. `branchToSessionName` (built from the
 * same `session.list` rows already fetched for the session-list pane, via
 * `SessionRow.branch`) does that resolution here, so the matrix reads by
 * session name like every other pane instead of leaking raw branch names.
 * An unresolvable branch (session gone, or literally not found) falls back to
 * showing the pair as unknown rather than crashing or guessing.
 */
export function formatConvergenceMatrix(
  sessionNames: string[],
  pairwise: { a: string; b: string; result: string }[],
  branchToSessionName: Map<string, string>,
): string[][] {
  const grid: string[][] = sessionNames.map((_, i) => sessionNames.map((_, j) => (i === j ? '—' : '?')));
  for (const p of pairwise) {
    const i = sessionNames.indexOf(branchToSessionName.get(p.a) ?? p.a);
    const j = sessionNames.indexOf(branchToSessionName.get(p.b) ?? p.b);
    if (i === -1 || j === -1 || i === j) continue;
    // Only clean/not-clean is shown — 'test_fail' and 'unverified' trials still
    // mean "don't land this pair together", same practical signal as 'conflict'.
    const cell = p.result === 'clean' ? 'clean' : 'conflict';
    grid[i]![j] = cell;
    grid[j]![i] = cell;
  }
  return grid;
}

/**
 * Thin wrapper around `format()` (src/notify/dispatcher.ts) — a timestamp prefixed
 * onto the exact same title/message text the desktop notification uses. Deliberately
 * not a parallel reimplementation: reusing `format()` verbatim is what keeps the
 * feed pane and the OS notification from drifting apart (design doc §3.2).
 */
export function formatFeedLine(event: NotifyEvent): string {
  const { title, message } = format(event);
  return `${new Date().toLocaleTimeString()}  ${title}: ${message}`;
}

/**
 * Pure ordering loop for `L` (land all) — mirrors `cw land all`'s existing logic
 * (src/cli/commands/land.ts's `allCommand`) but takes an injected `land` function
 * instead of a `DaemonClient`, so it's testable without a real RPC call (see
 * tests/cli/tui-actions.test.ts). Stops at the first failure rather than
 * continuing past it, same as the CLI command.
 */
export async function landAllInOrder(
  names: string[],
  land: (name: string) => Promise<void>,
): Promise<{ landed: string[]; failedAt: string | undefined }> {
  const landed: string[] = [];
  for (const name of names) {
    try {
      await land(name);
      landed.push(name);
    } catch {
      return { landed, failedAt: name };
    }
  }
  return { landed, failedAt: undefined };
}

/**
 * Pure sequencing behind the y/n confirm prompt's "unregister the action
 * layer, wait for a key, re-register it" flow — see `confirmDestructive`'s
 * own doc comment in `run()` for WHY this ordering matters (a real
 * @opentui/keymap + terminal race between the keymap's prepended listener
 * and this prompt's own one-shot listener). Takes `unregisterLayer`/
 * `registerLayer`/`waitForKey` as injected dependencies, mirroring
 * `landAllInOrder`'s pattern above, so the CALL ORDER (unregister before
 * waiting, register after any answer, including on an unexpected key or a
 * rejected wait) is covered by a test that doesn't need a real renderer.
 * This does not, and cannot without a live terminal, prove the underlying
 * keymap race itself stays closed — only that a future refactor can't
 * silently drop the unregister/re-register calls.
 */
export async function confirmWithLayerPaused(
  unregisterLayer: () => void,
  registerLayer: () => void,
  waitForKey: () => Promise<{ name: string }>,
): Promise<boolean> {
  unregisterLayer();
  try {
    const key = await waitForKey();
    return key.name === 'y';
  } finally {
    registerLayer();
  }
}

/** Injected actions behind {@link buildActionLayerBindings} — one per key binding. */
export interface ActionLayerActions {
  newSession: () => void;
  land: () => void;
  landAll: () => void;
  kill: () => void;
  gc: () => void;
  quit: () => void;
}

/**
 * Builds the action layer's key bindings — factored out of `registerActionLayer`
 * (in `run()`) purely so a test can assert on the array directly (see
 * tests/cli/tui.test.ts) without a live keymap/renderer, mirroring
 * `confirmWithLayerPaused`'s injected-dependencies pattern above.
 *
 * `q` (quit) is deliberately in THIS SAME array as the other 5 keys (Critical 1
 * fix): `registerActionLayer` scopes the whole array to `sessionList`'s focus via
 * `targetMode: 'focus'`, so `q` now inherits the exact same scoping (inert while
 * the new-session form has focus) and the exact same unregister/re-register-
 * around-a-confirm behavior `confirmDestructive` already provides for the other
 * 5 — instead of running as a separate, unscoped raw keypress listener that used
 * to fire even while a form field or a y/n confirm had the user's attention (e.g.
 * typing a session name containing "q", like `query-api`, used to instantly quit).
 *
 * `x`, not `k` (Important 6 fix): `@opentui/core`'s `SelectRenderable` ships its
 * own default `k` → move-up binding (confirmed against
 * node_modules/@opentui/core's `defaultSelectKeybindings`, alongside `j` →
 * move-down, already relied on above). This layer's `k` ran first and stopped
 * propagation, so vim-style up-navigation was silently dead — worse, it opened a
 * kill confirmation instead, which a reflexive `y` (muscle memory for "yes, go
 * up") could turn into an actual accidental session kill, undermining the
 * destructive-confirmation requirement (design doc §5.4) even though a confirm
 * prompt was technically still shown. `x` is confirmed (same source) not to
 * collide with `defaultSelectKeybindings` or any other key this layer/app uses.
 */
export function buildActionLayerBindings(actions: ActionLayerActions): Binding<Renderable, KeyEvent>[] {
  return [
    { key: 'n', cmd: actions.newSession },
    { key: 'l', cmd: actions.land },
    // Not 'L': this library's own key names are lowercase with a separate
    // `shift` flag (confirmed against @opentui/core's own default Textarea
    // bindings, e.g. `{ name: 'a', ctrl: true, shift: true }` for
    // ctrl+shift+a) — `'L'` would compile to `{name:'L', shift:false}`, which
    // a real capital-L keypress (`{name:'l', shift:true}`) never matches.
    // `'shift+l'` is this library's spelling for "capital L".
    { key: 'shift+l', cmd: actions.landAll },
    // Deferred via `queueMicrotask`, unlike the 3 bindings above: `kill`/`gc`
    // call `confirmDestructive`, which unregisters this very layer. Doing that
    // synchronously here would be nested inside the keymap's own live dispatch
    // call stack for this keypress (`handleKeyEvent` → `dispatchLayers` →
    // `runBinding` → this `cmd`) — unsupported structural re-entry per the
    // library's own docs. Deferring to a microtask runs it after that dispatch
    // has fully unwound, still strictly before any later keypress (a
    // macrotask) can arrive.
    { key: 'x', cmd: () => { queueMicrotask(actions.kill); } },
    { key: 'g', cmd: () => { queueMicrotask(actions.gc); } },
    { key: 'q', cmd: actions.quit },
  ];
}

/**
 * The `run()` `catch` block's cleanup-then-report sequencing (Important 4 fix) —
 * extracted so a test can assert the ORDER without a real renderer/TTY. `report`
 * stands in for `fail()` (src/cli/context.ts), which calls `process.exit()` —
 * and `process.exit()` terminates the process immediately, before any pending
 * `finally` block runs (confirmed empirically in this repo's Bun 1.3.14). That is
 * exactly why this cleanup must happen in `catch`, BEFORE calling `report`, and
 * not in `finally`: anything after `report` in this same function, `finally`
 * included, is unreachable on the real `fail()` path. `renderer` is optional and
 * a plain `{ destroy(): void }` (not the full `CliRenderer`) so a test can inject
 * a fake — covers both "renderer setup never got far enough to be assigned"
 * (`undefined`, `?.destroy()` no-ops) and "already destroyed via some other path"
 * (idempotent, per `CliRenderer.destroy()`'s own `_isDestroyed` guard — see
 * `waitForQuit`'s doc comment above).
 */
export function destroyRendererBeforeReporting(
  renderer: { destroy(): void } | undefined,
  err: unknown,
  report: (err: unknown) => void,
): void {
  renderer?.destroy();
  report(err);
}

/**
 * Determines how to re-invoke this same `cw` process as a child (for `session
 * attach`) — verified against real `process.argv`/`process.execPath` output
 * in both run modes (see task-8-report.md's "Step 1 observations" for the
 * exact captured values), not assumed from the plan's illustrative snippet.
 *
 * Source mode (`bun src/cli/index.ts tui`): `execPath` is bun's own runtime
 * binary and `argv[1]` is the real, spawnable path to `src/cli/index.ts` —
 * `[execPath, argv[1]]` re-invokes exactly that, without relying on `bun`
 * being resolvable via `PATH` (unlike spawning the literal string `'bun'`).
 *
 * Compiled mode (`dist/cw`, built via `bun build --compile`): `argv[1]` is
 * Bun's own internal virtual-filesystem path (`/$bunfs/root/cw`), not a real
 * file — spawning it fails. `execPath`, however, resolves to the compiled
 * binary's own real absolute path in this mode (confirmed for both relative
 * and absolute invocation of the binary), so `[execPath]` alone re-invokes
 * the binary itself, argv and all.
 *
 * The `/$bunfs/` prefix on `argv[1]` is the one observable difference between
 * the two modes, so it's what tells them apart here.
 */
export function resolveSelfInvocation(argv: string[], execPath: string): string[] {
  const scriptPath = argv[1];
  if (scriptPath?.startsWith('/$bunfs/')) return [execPath];
  return [execPath, scriptPath as string];
}

/**
 * Attach-in-place (design doc §4.4): suspends this TUI's own renderer, runs
 * `cw session attach <name>` as a child process with inherited stdio so it
 * gets the real terminal directly (scrollback replay, raw mode, the Ctrl-]
 * detach convention — all already handled by src/cli/commands/attach.ts,
 * zero new PTY-relay code here), waits for it to exit, then resumes.
 *
 * `renderer.suspend()`/`.resume()` (not `.pause()`/`.start()`, and definitely
 * not `.stop()` — see `waitForQuit`'s doc comment above on why `.stop()` is
 * wrong for anything terminal-restoring) are real methods on the installed
 * @opentui/core's `CliRenderer` (confirmed by reading
 * node_modules/@opentui/core/chunk-bun-*.js directly, not just its .d.ts):
 * `suspend()` turns off raw mode, pauses stdin, and removes the library's own
 * exit listeners; `resume()` reverses all of that. The `finally` guarantees
 * `resume()` still runs even if the attached process is killed out from under
 * it (e.g. from a third terminal) rather than exiting cleanly.
 */
async function attachToSession(name: string, renderer: CliRenderer, selfInvocation: string[]): Promise<void> {
  renderer.suspend();
  try {
    const proc = Bun.spawn([...selfInvocation, 'session', 'attach', name], {
      stdio: ['inherit', 'inherit', 'inherit'],
    });
    await proc.exited;
  } finally {
    renderer.resume();
  }
}

function branchToSessionNameMap(sessions: SessionRow[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of sessions) {
    if (s.branch) map.set(s.branch, s.name);
  }
  return map;
}

/** Renders `formatConvergenceMatrix`'s grid as a monospaced text table, matching
 * how `cw converge status` (src/cli/commands/converge.ts) already reports pairs. */
function renderConvergenceMatrixText(sessionNames: string[], grid: string[][]): string {
  if (sessionNames.length === 0) return 'no active sessions';
  const colWidth = Math.max(...sessionNames.map((n) => n.length), 'conflict'.length) + 1;
  const pad = (s: string) => s.padEnd(colWidth);
  const header = pad('') + sessionNames.map(pad).join('');
  const rows = sessionNames.map((name, i) => pad(name) + grid[i]!.map(pad).join(''));
  return [header, ...rows].join('\n');
}

function convergenceMatrixText(sessions: SessionRow[], convergeStatus: ConvergeStatus): string {
  const sessionNames = sessions.map((s) => s.name);
  const grid = formatConvergenceMatrix(sessionNames, convergeStatus.pairwise, branchToSessionNameMap(sessions));
  return renderConvergenceMatrixText(sessionNames, grid);
}

function sessionsToOptions(sessions: SessionRow[]): SelectOption[] {
  return sessions.map((row) => {
    const { text, dot } = formatSessionRow(row);
    return { name: `${dot} ${text}`, description: row.branch ?? row.worktreePath ?? row.id, value: row.id };
  });
}

/**
 * Duck-typed subset of `CliRenderer` this needs — narrow enough that a test can
 * fake it without spinning up a real renderer (which needs a real TTY).
 */
interface QuitAwareRenderer {
  on(event: string, listener: () => void): void;
}

/**
 * Resolves once the renderer is actually destroyed — whether that's triggered by
 * the `q` keymap binding (see `buildActionLayerBindings` above — Critical 1 fix:
 * `q` used to be a raw, unscoped `keyInput.on('keypress', ...)` listener registered
 * directly by THIS function, which is what let it quit the whole TUI on an ordinary
 * "q" keystroke typed into the new-session form or a y/n confirm; it is now just
 * another binding in the same focus-scoped action layer as n/l/shift+l/x/g, subject
 * to the identical scoping and the identical pause-during-confirm behavior) or by
 * the library's own signal-triggered `exitHandler` (SIGINT/SIGTERM/etc., see
 * `createCliRenderer`'s call site) — never by `renderer.stop()`, which only clears
 * internal timers/control-state and never restores the terminal (no
 * `stdin.setRawMode(false)`, no alternate-screen teardown — verified against
 * `node_modules/@opentui/core`'s actual `cleanupBeforeDestroy`/`finalizeDestroy`).
 * Using the renderer's own 'destroy' event as the single completion signal means
 * every path that ends in a real terminal restore also lets `run()` reach its
 * `finally` and close the daemon connection, instead of only 'q' being able to.
 * This function no longer listens for keypresses itself — quitting is now entirely
 * the keymap binding's job, same as every other action in this file.
 */
export function waitForQuit(renderer: QuitAwareRenderer): Promise<void> {
  return new Promise<void>((resolve) => {
    renderer.on(CliRenderEvents.DESTROY, () => resolve());
  });
}

export const tuiCommand = defineCommand({
  meta: { name: 'tui', description: 'Live dashboard — sessions, radar, convergence, budget' },
  async run() {
    // Deliberately NOT withClient (src/cli/context.ts) — that closes the connection
    // right after one call. This command holds one connection for its whole
    // lifetime, closing it only on quit. See plan Global Constraints.
    const projectRoot = findProjectRoot(process.cwd());
    loadConfig(projectRoot);
    let client: DaemonClient | undefined;
    // Hoisted so the `catch` block below can reach it (Important 4 fix): any
    // synchronous throw between `createCliRenderer()` returning and `waitForQuit`
    // being reached — the ~90 lines of `BoxRenderable`/`SelectRenderable`/
    // `TextRenderable` construction and `keymap.registerLayer` calls in between —
    // used to propagate straight to `catch (err) { fail(err) }`, and `fail()` calls
    // `process.exit(1)` with the terminal still in raw mode and the alternate screen
    // still active, leaving the user's shell broken with no explanation. This is a
    // SEPARATE binding from the `const renderer` created inside `try` below (which
    // every other closure in this function keeps using unchanged) — it exists purely
    // so `catch` has a reference to call `.destroy()` on BEFORE calling `fail(err)`,
    // not in `finally`: `process.exit()` terminates the process immediately, before
    // any pending `finally` block runs (confirmed empirically in this repo's Bun
    // 1.3.14 — a `finally` after a `process.exit()` call never executes), so a
    // `finally`-only cleanup would be dead code on exactly this path. `.destroy()` is
    // idempotent-safe whether or not `q`/a signal already destroyed it (confirmed
    // against node_modules/@opentui/core's actual `CliRenderer.destroy()`: it no-ops
    // if `_isDestroyed` is already true), and safe if renderer setup never got far
    // enough to assign it (stays `undefined`, `?.destroy()` no-ops).
    let rendererForCleanup: CliRenderer | undefined;
    try {
      client = await connectOrStart(projectRoot);
      // Narrowed, non-optional binding: `refresh` below is a nested function, and TS
      // does not carry the `client is DaemonClient` narrowing from the assignment
      // above across a closure boundary.
      const conn = client;

      const ws = await conn.call<WorkspaceInit>('workspace.init', {});

      let sessionListPane: SelectRenderable | undefined;
      let convergenceMatrixPane: TextRenderable | undefined;
      let statusBarPane: TextRenderable | undefined;
      let feedPane: TextRenderable | undefined;

      /**
       * Appends one line per `'tui.event'`, capped at `FEED_MAX_LINES` so a
       * long-running `cw tui` process never grows this pane's backing text
       * unboundedly. Scrolled to the bottom on every append so the newest line
       * (design doc §4.1: "newest at the bottom") is always the one visible.
       */
      function appendFeedLine(event: NotifyEvent): void {
        latestFeedLines.push(formatFeedLine(event));
        if (latestFeedLines.length > FEED_MAX_LINES) latestFeedLines = latestFeedLines.slice(-FEED_MAX_LINES);
        if (feedPane) {
          feedPane.content = latestFeedLines.join('\n');
          feedPane.scrollY = feedPane.maxScrollY;
        }
      }

      /**
       * Both the initial data load and every `'tui.invalidate'`-triggered reload run
       * through this one function — it always updates the module-level `latestX`
       * state, and updates the rendered panes too whenever they've been mounted
       * (they haven't yet the first time this runs, before `createCliRenderer`).
       */
      async function refresh(): Promise<void> {
        const [sessions, convergeStatus, workspaceInfo] = await Promise.all([
          conn.call<SessionRow[]>('session.list', { workspaceId: ws.id }),
          conn.call<ConvergeStatus>('converge.status', { workspaceId: ws.id }),
          conn.call<WorkspaceInfo>('workspace.info', { id: ws.id }),
        ]);
        latestSessions = sessions;
        latestConvergeStatus = convergeStatus;
        latestWorkspaceInfo = workspaceInfo;
        if (sessionListPane) sessionListPane.options = sessionsToOptions(sessions);
        if (convergenceMatrixPane) convergenceMatrixPane.content = convergenceMatrixText(sessions, convergeStatus);
        if (statusBarPane) statusBarPane.content = formatStatusBar(workspaceInfo.workspace, sessions, workspaceInfo.disk);
      }

      // Registered before daemon.subscribe (matching attach.ts's established
      // register-before-subscribe pattern) so an invalidate broadcast that lands the
      // instant subscription takes effect — even before the panes below exist — is
      // never missed.
      conn.onNotification((method, params) => {
        // A refresh failure (daemon restart, workspace deleted mid-session) must not
        // become an unhandled rejection in this long-running interactive command —
        // matches watcher.ts/convergence-scheduler.ts's own fire-and-forget
        // background-tick pattern (log and keep the dashboard up, don't crash it).
        if (method === 'tui.invalidate') {
          void refresh().catch((err: unknown) => {
            process.stderr.write(`crossweave: tui refresh failed: ${String(err)}\n`);
          });
        } else if (method === 'tui.event') {
          // `params` is the full notify()-event payload (design doc §3.2) — the
          // daemon broadcasts it verbatim (src/daemon/methods.ts), so it's trusted
          // to already match `NotifyEvent`'s shape without further validation here.
          appendFeedLine(params as NotifyEvent);
        }
      });
      await conn.call('daemon.subscribe', {});
      await refresh();

      // No `exitSignals` override: the library's own default (SIGINT/SIGTERM/SIGHUP/
      // etc.) must stay wired up, or none of those signals ever restore the terminal
      // — `renderer.destroy()` is the only thing that calls `stdin.setRawMode(false)`
      // and tears down the alternate screen, and an empty `exitSignals` array disables
      // the library's own signal-triggered call to it entirely.
      const renderer = await createCliRenderer({ exitOnCtrlC: false });
      rendererForCleanup = renderer;
      const root = new BoxRenderable(renderer, {
        id: 'root',
        width: '100%',
        height: '100%',
        borderStyle: 'rounded',
        title: `crossweave — ${ws.name}`,
        titleAlignment: 'left',
        flexDirection: 'column',
      });
      renderer.root.add(root);

      sessionListPane = new SelectRenderable(renderer, {
        id: 'session-list',
        width: '100%',
        flexGrow: 1,
        options: sessionsToOptions(latestSessions),
      });
      root.add(sessionListPane);
      // Narrowed, non-optional binding: the keymap actions below are nested
      // functions, and TS does not carry the assignment-above narrowing of the
      // module-level `sessionListPane` across a closure boundary (same reason
      // `conn` exists alongside `client` above).
      const sessionList = sessionListPane;
      // Explicit, not relying on `CliRenderer`'s own `autoFocus` default: the
      // keymap layer below is scoped to `sessionList`'s focus (`targetMode:
      // 'focus'`), so it only ever fires if this renderable actually holds
      // focus. `closeForm()` further down restores focus here the same way
      // after the new-session form closes.
      sessionList.focus();

      const convergenceBox = new BoxRenderable(renderer, {
        id: 'convergence-matrix-box',
        width: '100%',
        height: 'auto',
        borderStyle: 'single',
        title: 'Convergence',
        titleAlignment: 'left',
      });
      root.add(convergenceBox);
      convergenceMatrixPane = new TextRenderable(renderer, {
        id: 'convergence-matrix',
        width: '100%',
        height: 'auto',
        content: latestConvergeStatus ? convergenceMatrixText(latestSessions, latestConvergeStatus) : '',
      });
      convergenceBox.add(convergenceMatrixPane);

      const radarFeedBox = new BoxRenderable(renderer, {
        id: 'radar-feed-box',
        width: '100%',
        height: 8,
        borderStyle: 'single',
        title: 'Radar feed',
        titleAlignment: 'left',
      });
      root.add(radarFeedBox);
      feedPane = new TextRenderable(renderer, {
        id: 'radar-feed',
        width: '100%',
        height: '100%',
        content: latestFeedLines.join('\n'),
      });
      radarFeedBox.add(feedPane);
      feedPane.scrollY = feedPane.maxScrollY;

      statusBarPane = new TextRenderable(renderer, {
        id: 'status-bar',
        width: '100%',
        height: 1,
        content: latestWorkspaceInfo
          ? formatStatusBar(latestWorkspaceInfo.workspace, latestSessions, latestWorkspaceInfo.disk)
          : '',
      });
      root.add(statusBarPane);

      // One-line pane for keymap-action feedback: the y/n confirm prompt text
      // (destructive ops, design doc §5.4) and the outcome of every action below
      // (created/landed/killed/gc'd, or an error) — so a failure is shown, never
      // silently swallowed (plan Step 5). Placed above the status bar so it reads
      // as transient, unlike the persistent panes above it.
      const actionStatusPane = new TextRenderable(renderer, {
        id: 'action-status',
        width: '100%',
        height: 1,
        content: '',
      });
      root.add(actionStatusPane, root.getChildren().indexOf(statusBarPane));

      function setActionStatus(text: string): void {
        actionStatusPane.content = text;
      }

      // Important 5 fix: without this, a dropped daemon connection (daemon crash,
      // `cw daemon stop` from another terminal) was invisible — RPC calls fail fast
      // per-action (already surfaced via `setActionStatus` in each action's own
      // catch), but the panes themselves keep showing stale pre-death data forever,
      // since no further `tui.invalidate`/`tui.event` can ever arrive. `conn.onClose`
      // (src/client/rpc-client.ts) fires exactly once, whether the connection died
      // from a socket 'error', 'close', or 'end' — this is deliberately the only
      // reconnect-adjacent behavior this command has; there is no actual reconnect
      // logic, the user must quit (`q` still works — the daemon connection dying
      // doesn't affect the renderer) and re-run `cw tui`.
      conn.onClose(() => setActionStatus('daemon connection lost — press q to exit'));

      // Guards every action below against re-entrancy: a keymap binding stays
      // "active" (still matched against `sessionList`'s focus) for the whole
      // duration of a y/n confirm, since the confirm prompt deliberately doesn't
      // move focus off `sessionList` (brief: "a simple TextRenderable ... plus a
      // one-shot keypress listener, not a full modal component"). Without this
      // flag, e.g. pressing 'n' while a kill confirm is showing would ALSO open
      // the new-session form. This is a SEPARATE problem from the keymap-vs-
      // confirm race handled by `unregisterActionLayer` below — this flag
      // guards against a SECOND action starting; that mechanism guards against
      // the confirm's own y/n listener losing keys to the still-registered layer.
      let uiBusy = false;

      // Assigned once the keymap layer is actually registered, further down —
      // `confirmDestructive` only ever CALLS this at real keypress time (long
      // after setup finishes), not at definition time, so forward-referencing
      // it here through the closure is safe.
      let unregisterActionLayer: () => void;

      function getSelectedSession(): SessionRow | undefined {
        return latestSessions[sessionList.getSelectedIndex()];
      }

      /**
       * One-shot y/n confirm, per design doc §5.4 — any key other than 'y'
       * cancels.
       *
       * Delegates the unregister/wait/re-register sequencing to
       * `confirmWithLayerPaused` (see its own doc comment for the full
       * mechanism). Unregistering the action-layer bindings (`x`/`g`/etc.)
       * for the duration of the prompt is load-bearing, not defensive:
       * `renderer.keyInput` is actually `InternalKeyHandler` (undeclared in
       * @opentui/core's own .d.ts — confirmed by reading
       * node_modules/@opentui/core/chunk-bun-*.js directly), whose `emit()`
       * override iterates 'keypress' listeners one at a time and stops
       * calling later ones the instant a listener sets
       * `event.propagationStopped`. The keymap's own listener is prepended
       * (`onKeyPress` uses `prependListener`), so it always runs before this
       * function's `.once` listener — and it DOES call
       * `event.stopPropagation()` for every one of this layer's 6 bindings,
       * since a `cmd` handler returning `undefined` (all 6 of ours do) is
       * treated as "handled" by `executeResolvedCommand`, regardless of
       * whether the handler body itself no-ops via `uiBusy`. Without the
       * unregister, pressing `n`/`l`/`shift+l`/`x`/`g`/`q` while a confirm is
       * showing would be silently eaten by the keymap layer before this
       * `.once` listener ever sees it — breaking "any other key cancels" for
       * exactly the keys a user is likely to press next.
       *
       * `q` is one of the 6 (Critical 1 fix), so it is unregistered here too:
       * pressing `q` while a confirm is showing does NOT quit — the layer's `q`
       * binding is gone for the duration, so the keypress instead reaches this
       * function's own `.once` listener below, which treats any non-'y' key
       * (including 'q') as "cancel". Quit only actually fires the next time `q`
       * is pressed after the layer is re-registered.
       *
       * `unregisterLayer` here is only ever reached from `killSelected`/
       * `runGc`'s bindings, both deferred via `queueMicrotask` — never
       * synchronously nested inside the keymap's own dispatch call stack for
       * the keypress that triggered it, which the library's own docs warn
       * against ("Structural re-entry is not supported. Do not register or
       * unregister layers ... while a dispatch is in flight."). The
       * re-register (in `confirmWithLayerPaused`'s `finally`, after
       * `waitForKey`'s promise settles) runs even later, on its own
       * microtask turn — safely clear of that same concern.
       */
      function confirmDestructive(prompt: string): Promise<boolean> {
        setActionStatus(`${prompt} (y/n)`);
        return confirmWithLayerPaused(
          () => unregisterActionLayer(),
          () => {
            unregisterActionLayer = registerActionLayer();
          },
          () => new Promise<KeyEvent>((resolve) => renderer.keyInput.once('keypress', resolve)),
        );
      }

      async function openNewSessionForm(): Promise<void> {
        if (uiBusy) return;
        uiBusy = true;

        const formBox = new BoxRenderable(renderer, {
          id: 'new-session-form',
          width: '100%',
          height: 'auto',
          borderStyle: 'single',
          title: 'New session — name, Enter, agent, Enter (Esc to cancel)',
          titleAlignment: 'left',
        });
        const nameInput = new InputRenderable(renderer, {
          id: 'new-session-name',
          width: '100%',
          placeholder: 'session name',
        });
        const agentInput = new InputRenderable(renderer, {
          id: 'new-session-agent',
          width: '100%',
          placeholder: 'agent',
          value: 'claude',
        });
        formBox.add(nameInput);
        formBox.add(agentInput);
        root.add(formBox, root.getChildren().indexOf(actionStatusPane));

        const closeForm = (): void => {
          root.remove(formBox);
          formBox.destroyRecursively();
          sessionList.focus();
          uiBusy = false;
        };
        const onEscape = (key: KeyEvent): void => {
          if (key.name === 'escape') closeForm();
        };
        nameInput.onKeyDown = onEscape;
        agentInput.onKeyDown = onEscape;

        nameInput.on(InputRenderableEvents.ENTER, (name: string) => {
          if (!name.trim()) {
            setActionStatus('session name is required');
            return;
          }
          agentInput.focus();
        });

        agentInput.on(InputRenderableEvents.ENTER, (agent: string) => {
          const name = nameInput.value.trim();
          if (!name) {
            setActionStatus('session name is required');
            nameInput.focus();
            return;
          }
          const agentKind = agent.trim() || 'claude';
          closeForm();
          void conn
            .call('session.new', { workspaceId: ws.id, name, agent: agentKind })
            .then(() => setActionStatus(`created session ${name}`))
            .catch((err: unknown) => setActionStatus(`create session failed: ${(err as Error).message}`));
        });

        nameInput.focus();
      }

      async function landSelected(): Promise<void> {
        if (uiBusy) return;
        const session = getSelectedSession();
        if (!session) {
          setActionStatus('no session selected');
          return;
        }
        uiBusy = true;
        try {
          await conn.call('land.session', { workspaceId: ws.id, idOrName: session.name });
          setActionStatus(`landed ${session.name}`);
        } catch (err) {
          setActionStatus(`land failed: ${(err as Error).message}`);
        } finally {
          uiBusy = false;
        }
      }

      async function landAll(): Promise<void> {
        if (uiBusy) return;
        uiBusy = true;
        try {
          const status = await conn.call<ConvergeStatus>('converge.status', { workspaceId: ws.id });
          if (status.conflictFree.length === 0) {
            setActionStatus('nothing to land');
            return;
          }
          const result = await landAllInOrder(status.conflictFree, async (name) => {
            await conn.call('land.session', { workspaceId: ws.id, idOrName: name });
          });
          setActionStatus(
            result.failedAt
              ? `landed ${result.landed.join(', ') || '(none)'}; stopped at ${result.failedAt}`
              : `landed ${result.landed.join(', ')}`,
          );
        } catch (err) {
          setActionStatus(`land all failed: ${(err as Error).message}`);
        } finally {
          uiBusy = false;
        }
      }

      async function killSelected(): Promise<void> {
        if (uiBusy) return;
        const session = getSelectedSession();
        if (!session) {
          setActionStatus('no session selected');
          return;
        }
        uiBusy = true;
        try {
          const confirmed = await confirmDestructive(`kill ${session.name}?`);
          if (!confirmed) {
            setActionStatus('cancelled');
            return;
          }
          await conn.call('session.kill', { workspaceId: ws.id, idOrName: session.name });
          setActionStatus(`killed ${session.name}`);
        } catch (err) {
          setActionStatus(`kill failed: ${(err as Error).message}`);
        } finally {
          uiBusy = false;
        }
      }

      async function runGc(): Promise<void> {
        if (uiBusy) return;
        uiBusy = true;
        try {
          const confirmed = await confirmDestructive('run gc?');
          if (!confirmed) {
            setActionStatus('cancelled');
            return;
          }
          await conn.call('workspace.gc', { id: ws.id });
          setActionStatus('gc complete');
        } catch (err) {
          setActionStatus(`gc failed: ${(err as Error).message}`);
        } finally {
          uiBusy = false;
        }
      }

      // Computed once, not per-attach: `process.argv`/`process.execPath` don't
      // change while this process is running, so the same invocation is valid
      // for every Enter press.
      const selfInvocation = resolveSelfInvocation(process.argv, process.execPath);

      /**
       * Enter on the selected session — design doc §4.4. Wired to
       * `SelectRenderable`'s own `ITEM_SELECTED` event (fired from its
       * built-in `return`/`linefeed` key handling, confirmed against
       * node_modules/@opentui/core's actual `SelectRenderable.selectCurrent`),
       * not a new keymap binding: `return` doesn't collide with any of the
       * keymap layer's own keys ('n'/'l'/'shift+l'/'x'/'g'/'q') below, so no
       * unregister/re-register dance is needed here the way `confirmDestructive`
       * needs one for its y/n prompt.
       */
      async function attachSelected(): Promise<void> {
        if (uiBusy) return;
        const session = getSelectedSession();
        if (!session) {
          setActionStatus('no session selected');
          return;
        }
        uiBusy = true;
        try {
          await attachToSession(session.name, renderer, selfInvocation);
          setActionStatus(`detached from ${session.name}`);
        } catch (err) {
          setActionStatus(`attach failed: ${(err as Error).message}`);
        } finally {
          uiBusy = false;
        }
      }
      sessionList.on(SelectRenderableEvents.ITEM_SELECTED, () => void attachSelected());

      // `createDefaultOpenTuiKeymap`, not the bare `createOpenTuiKeymap`: the
      // core keymap ships with zero binding parsers registered (confirmed
      // against node_modules/@opentui/keymap/src/index.js — a bare keymap
      // throws "No keymap binding parsers are registered" for any string-keyed
      // binding, caught per-binding and turned into a silently-dropped
      // 'binding-parse-error'). `createDefaultOpenTuiKeymap` registers
      // `registerDefaultKeys` first, which is what actually parses plain keys
      // like 'n'/'l'/'L'/'x'/'g'/'q'.
      //
      // Scoped to `sessionList`'s own focus (targetMode: 'focus'), not a global
      // layer: this is what keeps these 6 keys from firing while the new-session
      // form has focus (letters typed into the name/agent fields must reach the
      // `InputRenderable`s, not this layer) — the keymap re-checks the focused
      // target on every keypress, so moving focus off `sessionList` deactivates
      // the whole layer without any manual enable/disable bookkeeping. `q` is
      // part of this same layer (Critical 1 fix) specifically to inherit this
      // scoping — see `buildActionLayerBindings`'s own doc comment.
      const keymap = createDefaultOpenTuiKeymap(renderer);
      // Factored out (not an inline `keymap.registerLayer({...})` call) so
      // `confirmDestructive` above can unregister and re-register it around a
      // y/n confirm — see that function's own doc comment for why. The actual
      // bindings array comes from `buildActionLayerBindings` (top of file), kept
      // separate so it's testable without a live keymap/renderer.
      function registerActionLayer(): () => void {
        return keymap.registerLayer({
          target: sessionList,
          targetMode: 'focus',
          bindings: buildActionLayerBindings({
            newSession: () => void openNewSessionForm(),
            land: () => void landSelected(),
            landAll: () => void landAll(),
            kill: () => void killSelected(),
            gc: () => void runGc(),
            quit: () => renderer.destroy(),
          }),
        });
      }
      unregisterActionLayer = registerActionLayer();

      renderer.start();

      await waitForQuit(renderer);
    } catch (err) {
      // Renderer cleanup MUST happen here, before `fail(err)` — not in `finally`.
      // `fail()` (src/cli/context.ts) calls `process.exit(1)`, and `process.exit()`
      // terminates the process immediately, before any pending `finally` block runs
      // (confirmed empirically in this repo's Bun 1.3.14: a `try { throw } catch {
      // process.exit(1) } finally { ... }` never executes the `finally` body). A
      // `rendererForCleanup?.destroy()` in `finally` was therefore dead code on
      // exactly the path Important 4 (final review) was about — a synchronous throw
      // during renderer setup still left the terminal in raw mode with the alternate
      // screen active. `?.destroy()` stays a safe no-op if `renderer` was never
      // assigned (setup failed before `createCliRenderer` returned) or if it was
      // already destroyed via some other path (idempotent — see `waitForQuit`'s doc
      // comment on `CliRenderer.destroy()`'s `_isDestroyed` guard). Delegated to
      // `destroyRendererBeforeReporting` (top of file) purely so the ORDER (destroy
      // before report) is covered by a test that doesn't need a real renderer/TTY.
      destroyRendererBeforeReporting(rendererForCleanup, err, fail);
    } finally {
      // `client?.close()` is, today, ALSO unreachable on this same catch path (`fail`
      // exits before `finally` runs) — but that's harmless and pre-existing: process
      // exit closes the socket anyway. Left in `finally` rather than moved, since the
      // normal (non-throwing) quit path still relies on `finally` to close it after
      // `waitForQuit` resolves.
      client?.close();
    }
  },
});
