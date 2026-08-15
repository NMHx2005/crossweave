import { defineCommand } from 'citty';
import {
  createCliRenderer,
  BoxRenderable,
  CliRenderEvents,
  SelectRenderable,
  TextRenderable,
  type SelectOption,
} from '@opentui/core';
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
  keyInput: { on(event: 'keypress', listener: (key: { name: string }) => void): void };
  destroy(): void;
}

/**
 * Resolves once the renderer is actually destroyed — whether that's triggered by
 * 'q' here or by the library's own signal-triggered `exitHandler` (SIGINT/SIGTERM/
 * etc., see `createCliRenderer`'s call site) — never by `renderer.stop()`, which
 * only clears internal timers/control-state and never restores the terminal
 * (no `stdin.setRawMode(false)`, no alternate-screen teardown — verified against
 * `node_modules/@opentui/core`'s actual `cleanupBeforeDestroy`/`finalizeDestroy`).
 * Using the renderer's own 'destroy' event as the single completion signal means
 * every path that ends in a real terminal restore also lets `run()` reach its
 * `finally` and close the daemon connection, instead of only 'q' being able to.
 */
export function waitForQuit(renderer: QuitAwareRenderer): Promise<void> {
  return new Promise<void>((resolve) => {
    renderer.on(CliRenderEvents.DESTROY, () => resolve());
    renderer.keyInput.on('keypress', (key) => {
      if (key.name === 'q') renderer.destroy();
    });
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

      renderer.start();

      await waitForQuit(renderer);
    } catch (err) {
      fail(err);
    } finally {
      client?.close();
    }
  },
});
