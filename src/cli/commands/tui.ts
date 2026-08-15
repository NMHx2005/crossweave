import { defineCommand } from 'citty';
import { createCliRenderer, BoxRenderable, CliRenderEvents } from '@opentui/core';
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

      const ws = await client.call<WorkspaceInit>('workspace.init', {});
      // Subscribed before the initial fetch below so an invalidate broadcast that
      // lands mid-fetch is never missed — the panes added in Tasks 4-6 re-fetch on
      // 'tui.invalidate' via client.onNotification.
      await client.call('daemon.subscribe', {});

      const [sessions, convergeStatus, workspaceInfo] = await Promise.all([
        client.call<SessionRow[]>('session.list', { workspaceId: ws.id }),
        client.call<ConvergeStatus>('converge.status', { workspaceId: ws.id }),
        client.call<WorkspaceInfo>('workspace.info', { id: ws.id }),
      ]);
      latestSessions = sessions;
      latestConvergeStatus = convergeStatus;
      latestWorkspaceInfo = workspaceInfo;

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
      });
      renderer.root.add(root);
      renderer.start();

      await waitForQuit(renderer);
    } catch (err) {
      fail(err);
    } finally {
      client?.close();
    }
  },
});
