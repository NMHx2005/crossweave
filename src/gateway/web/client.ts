import { DaemonClient } from '../../client/rpc-client.js';
import type { ClientTransport } from '../../client/transport.js';

/**
 * Minimal web client logic — framework-free, xterm.js wired by the HTML.
 * Connects via the provided transport (wsTransport in prod, memory in tests),
 * lists sessions, attaches to one, and forwards data/input.
 */
export interface WebClientOptions {
  transport: ClientTransport;
  onSessions?: (sessions: unknown[]) => void;
  onData?: (chunk: string) => void;
  onNotification?: (method: string, params: unknown) => void;
}

export async function createWebClient(opts: WebClientOptions): Promise<{ client: DaemonClient; attach: (sessionId: string) => Promise<void>; sendInput: (data: string, sessionId: string) => Promise<void>; openFile: (path: string, workspaceId?: string) => Promise<{ content: string }>; listFiles: (prefix?: string, workspaceId?: string) => Promise<{ files: { name: string; isDirectory: boolean }[] }> }> {
  const client = DaemonClient.attach(opts.transport);
  if (opts.onNotification) client.onNotification(opts.onNotification);
  // Notifications arrive as tui.event — the same seam Cockpit uses
  if (opts.onNotification) {
    client.onNotification((method, params) => opts.onNotification?.(method, params));
  }
  return {
    client,
    async attach(sessionId: string) {
      await client.call('session.attach', { sessionId });
      // session.data arrives as notifications — wire to onData
      if (opts.onData) {
        client.onNotification((method, params) => {
          if (method === 'session.data' && (params as { sessionId?: string })?.sessionId === sessionId) {
            const chunk = (params as { chunk?: string })?.chunk;
            if (typeof chunk === 'string') opts.onData?.(chunk);
          }
        });
      }
    },
    async listFiles(prefix = '', workspaceId?: string) {
      return client.call<{ files: { name: string; isDirectory: boolean }[] }>('workspace.listFiles', { prefix, ...(workspaceId ? { workspaceId } : {}) });
    },
    async openFile(path: string, workspaceId?: string) {
      return client.call<{ content: string }>('workspace.openFile', workspaceId ? { path, workspaceId } : { path });
    },
    async sendInput(data: string, sessionId: string) {
      await client.call('session.input', { sessionId, data });
    },
  };
}
