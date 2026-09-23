import type { ClientTransport } from '../client/transport.js';
import { unixSocketTransport } from '../client/transport.js';
import { READ_METHODS, appendAudit } from './auth.js';

/**
 * Stage 0 gateway: one WebSocket connection ↔ one unix-socket connection.
 * No auth yet — Stage 1 adds it. Binds to loopback only.
 *
 * For Stage 0 the process shape is: for each WS client, open a unix transport
 * to the daemon and shuttle frames both ways. Backpressure is implicit — WS
 * send() and socket write() are both buffered; a slow peer just buffers.
 * Unknown methods are rejected here (allowlist shape), not forwarded.
 */
export const ALLOWED_METHODS = new Set([
  'workspace.ensure', 'workspace.info', 'workspace.gc',
  'session.new', 'session.list', 'session.resume', 'session.stop', 'session.kill', 'session.rm',
  'session.input', 'session.resize', 'session.attach', 'session.data', 'session.exit',
  'session.rename', 'land.session', 'converge.status', 'tui.event', 'tui.invalidate',
  'journal.get', 'journal.set', 'usage.summary',
]);

export interface GatewayOptions {
  socketPath: string;
  projectRoot?: string;
  /** When set, the first RPC must present this token (as param `token` or `_token`). */
  requireToken?: string;
  /** Factory for tests — defaults to unixSocketTransport */
  connectDaemon?: (path: string) => Promise<ClientTransport>;
}

export async function createGatewayTransport(
  clientTransport: ClientTransport,
  opts: GatewayOptions,
): Promise<{ close: () => void }> {
  const daemon = await (opts.connectDaemon ?? unixSocketTransport)(opts.socketPath);
  let authed = opts.requireToken === undefined;
  // When requireToken was set, the presented token's kind decides what may be forwarded
  // For file-backed verify, we also support opts.projectRoot + verifyToken()
  let authedKind: 'read' | 'control' | undefined = authed ? 'control' : undefined;

  const onClientData = (chunk: Buffer | string) => {
    const text = chunk.toString();
    const lines = text.split('\n');
    let forwarded = '';
    for (const line of lines) {
      if (!line.trim()) { forwarded += '\n'; continue; }
      let blocked = false;
      try {
        const msg = JSON.parse(line) as { method?: string; id?: number; params?: Record<string, unknown> };
        // Auth gate: first RPC must present the token when requireToken is set
        if (!authed) {
          const tok = (msg.params as Record<string, unknown> | undefined)?.token
            ?? (msg.params as Record<string, unknown> | undefined)?._token;
          if (tok === opts.requireToken) {
            authed = true;
            authedKind = 'control';
            // Strip token before forwarding so the daemon never sees it
            if (msg.params) { delete (msg.params as Record<string, unknown>).token; delete (msg.params as Record<string, unknown>)._token; }
            // Rewrite line without token
            const cleaned = JSON.stringify(msg);
            forwarded += cleaned + '\n';
            continue;
          }
          if (typeof msg.id === 'number') {
            clientTransport.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Unauthorized: gateway token required' } }) + '\n');
          }
          blocked = true;
        } else if (msg.method && authedKind === 'read' && !READ_METHODS.has(msg.method)) {
          if (typeof msg.id === 'number') {
            clientTransport.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `Forbidden: ${msg.method} requires a control token` } }) + '\n');
          }
          blocked = true;
        } else if (msg.method && !ALLOWED_METHODS.has(msg.method)) {
          if (typeof msg.id === 'number') {
            clientTransport.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } }) + '\n');
          }
          blocked = true;
        }
      } catch {}
      if (!blocked) forwarded += line + '\n';
    }
    if (forwarded.trim()) {
      // Audit every forwarded method
      try {
        for (const line of forwarded.split('\n')) {
          if (!line.trim()) continue;
          const m = JSON.parse(line) as { method?: string };
          if (m.method && opts.projectRoot) appendAudit(opts.projectRoot, { method: m.method, kind: authedKind });
        }
      } catch {}
      daemon.write(forwarded);
    }
  };
  const onDaemonData = (chunk: Buffer | string) => clientTransport.write(chunk.toString());

  clientTransport.onData(onClientData);
  daemon.onData(onDaemonData);

  const closeBoth = () => { try { daemon.close(); } catch {} try { clientTransport.close(); } catch {} };
  clientTransport.onClose(closeBoth);
  clientTransport.onEnd(closeBoth);
  daemon.onClose(closeBoth);
  daemon.onEnd(closeBoth);
  daemon.onError(closeBoth);

  return { close: closeBoth };
}
