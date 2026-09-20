import { DaemonClient } from '../client/rpc-client.js';
import type { ClientTransport } from '../client/transport.js';
import { unixSocketTransport } from '../client/transport.js';
import { wsTransport } from '../gateway/ws-transport.js';

export interface DeckBridgeOptions {
  socketPath?: string;
  wsUrl?: string;
  transport?: ClientTransport;
}

export interface WorktreeCard {
  id: string;
  heading: string;
  branch: string | null;
  worktreePath: string | null;
  status: string;
}

/**
 * Bridge that exposes crossweave sessions as Deck worktree cards.
 * Thin over DaemonClient — one truth, N UIs.
 */
export class DeckBridge {
  constructor(private readonly client: DaemonClient) {}

  static async connect(opts: DeckBridgeOptions): Promise<DeckBridge> {
    let transport: ClientTransport;
    if (opts.transport) transport = opts.transport;
    else if (opts.wsUrl) transport = await wsTransport(opts.wsUrl);
    else if (opts.socketPath) transport = await unixSocketTransport(opts.socketPath);
    else throw new Error('DeckBridge.connect requires socketPath, wsUrl, or transport');
    return new DeckBridge(DaemonClient.attach(transport));
  }

  async listWorktrees(workspaceId: string): Promise<WorktreeCard[]> {
    const sessions = await this.client.call<WorktreeCard[]>('session.list', { workspaceId });
    return sessions.map((s) => ({ id: s.id, heading: s.id, branch: s.branch, worktreePath: s.worktreePath, status: s.status }));
  }

  async land(workspaceId: string, sessionId: string): Promise<unknown> {
    return this.client.call('land.session', { workspaceId, idOrName: sessionId });
  }

  onEvent(cb: (method: string, params: unknown) => void): void {
    this.client.onNotification(cb);
  }

  get clientRef(): DaemonClient { return this.client; }
}
