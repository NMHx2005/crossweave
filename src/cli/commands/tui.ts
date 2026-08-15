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

interface WorkspaceInit { id: string; name: string }
interface Workspace { id: string; name: string; rootPath: string; safeModeTier: string }
interface WorkspaceInfo { workspace: Workspace; sessions: SessionRow[] }
interface ConvergeStatus {
  pairwise: { a: string; b: string; result: string }[];
  fullIntegration: { result: string; ts: string; detail: string | null } | null;
  recommendedOrder: string[];
  degraded: boolean;
}

// Populated by the initial fetch in `run()` below and read by the panes Tasks 4-6
// add (session list, convergence matrix, workspace/budget info) — this task's only
// consumer of its own module state is proving the fetch/store plumbing works.
let latestSessions: SessionRow[] = [];
let latestConvergeStatus: ConvergeStatus | null = null;
let latestWorkspaceInfo: WorkspaceInfo | null = null;

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
 * `WorkspaceInfo` (src/domain/workspace.ts) is `{ workspace: WorkspaceRow, sessions:
 * SessionRow[] }` — there is no disk-usage field anywhere on `WorkspaceRow`, so this
 * only aggregates what `workspace.info`/`session.list` actually return: name,
 * session count, total burn.
 */
export function formatStatusBar(ws: { name: string }, sessions: SessionRow[]): string {
  const totalCost = sessions.reduce((sum, s) => sum + s.costSpentUsd, 0);
  const count = sessions.length;
  return `${ws.name}  |  ${count} session${count === 1 ? '' : 's'}  |  $${totalCost.toFixed(2)} spent`;
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
      let statusBarPane: TextRenderable | undefined;

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
        if (statusBarPane) statusBarPane.content = formatStatusBar(workspaceInfo.workspace, sessions);
      }

      // Registered before daemon.subscribe (matching attach.ts's established
      // register-before-subscribe pattern) so an invalidate broadcast that lands the
      // instant subscription takes effect — even before the panes below exist — is
      // never missed.
      conn.onNotification((method) => {
        if (method === 'tui.invalidate') void refresh();
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

      statusBarPane = new TextRenderable(renderer, {
        id: 'status-bar',
        width: '100%',
        height: 1,
        content: latestWorkspaceInfo ? formatStatusBar(latestWorkspaceInfo.workspace, latestSessions) : '',
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
