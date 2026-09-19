import type { ClientTransport } from '../client/transport.js';
import { unixSocketTransport } from '../client/transport.js';

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
]);

export interface GatewayOptions {
  socketPath: string;
  /** Factory for tests — defaults to unixSocketTransport */
  connectDaemon?: (path: string) => Promise<ClientTransport>;
}

export async function createGatewayTransport(
  clientTransport: ClientTransport,
  opts: GatewayOptions,
): Promise<{ close: () => void }> {
  const daemon = await (opts.connectDaemon ?? unixSocketTransport)(opts.socketPath);

  const onClientData = (chunk: Buffer | string) => {
    const text = chunk.toString();
    const lines = text.split('\n');
    let forwarded = '';
    for (const line of lines) {
      if (!line.trim()) { forwarded += '\n'; continue; }
      let blocked = false;
      try {
        const msg = JSON.parse(line) as { method?: string; id?: number };
        if (msg.method && !ALLOWED_METHODS.has(msg.method)) {
          if (typeof msg.id === 'number') {
            clientTransport.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } }) + '\n');
          }
          blocked = true;
        }
      } catch {}
      if (!blocked) forwarded += line + '\n';
    }
    if (forwarded.trim()) daemon.write(forwarded);
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
