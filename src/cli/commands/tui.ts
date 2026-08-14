import { defineCommand } from 'citty';
import { createCliRenderer, BoxRenderable } from '@opentui/core';
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

export const tuiCommand = defineCommand({
  meta: { name: 'tui', description: 'Live dashboard — sessions, radar, convergence, budget' },
  async run() {
    // Deliberately NOT withClient (src/cli/context.ts) — that closes the connection
    // right after one call. This command holds one connection for its whole
    // lifetime, closing it only on quit. See plan Global Constraints.
    const projectRoot = findProjectRoot(process.cwd());
    loadConfig(projectRoot);
    let client: DaemonClient;
    try {
      client = await connectOrStart(projectRoot);
    } catch (err) {
      fail(err);
    }

    try {
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

      const renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [] });
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

      await new Promise<void>((resolve) => {
        renderer.keyInput.on('keypress', (key) => {
          if (key.name === 'q') {
            renderer.stop();
            resolve();
          }
        });
      });
    } finally {
      client.close();
    }
  },
});
