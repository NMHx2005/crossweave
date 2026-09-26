import type { ClientTransport } from '../client/transport.js';
import { unixSocketTransport } from '../client/transport.js';
import { READ_METHODS, appendAudit, constantTimeEqual, verifyToken, type TokenKind } from './auth.js';

/**
 * Gateway: one WebSocket connection ↔ one unix-socket connection. The first frame
 * must present a control or read token; nothing reaches the daemon before that.
 *
 * For Stage 0 the process shape is: for each WS client, open a unix transport
 * to the daemon and shuttle frames both ways. Backpressure is implicit — WS
 * send() and socket write() are both buffered; a slow peer just buffers.
 * Unknown methods are rejected here (allowlist shape), not forwarded.
 */
export const ALLOWED_METHODS = new Set([
  'workspace.ensure', 'workspace.info', 'workspace.list', 'workspace.gc',
  'session.new', 'session.list', 'session.resume', 'session.stop', 'session.kill', 'session.rm',
  'session.input', 'session.resize', 'session.attach', 'session.data', 'session.exit',
  'session.rename', 'land.session', 'converge.status', 'tui.event', 'tui.invalidate',
  'journal.get', 'journal.set', 'usage.summary', 'workspace.openFile', 'workspace.listFiles', 'session.wait', 'session.unwait',
]);

export interface GatewayOptions {
  socketPath: string;
  /** File-backed credentials: the control and read tokens under `.crossweave/`. */
  projectRoot?: string;
  /** An explicit control token; takes precedence over `projectRoot`'s files. */
  requireToken?: string;
  /** Factory for tests — defaults to unixSocketTransport */
  connectDaemon?: (path: string) => Promise<ClientTransport>;
}

type Rejection = { code: number; message: string };

/**
 * The kind of access a presented token grants, or undefined.
 *
 * No configured credential grants nothing. The Stage 0 shape — "no token file yet,
 * so every client is control" — meant `cw gateway serve` before `cw gateway token`
 * exposed session.input to anything that could open the socket.
 */
function authenticate(opts: GatewayOptions, presented: unknown): TokenKind | undefined {
  if (typeof presented !== 'string' || presented === '') return undefined;
  if (opts.requireToken !== undefined) {
    return constantTimeEqual(presented, opts.requireToken) ? 'control' : undefined;
  }
  if (opts.projectRoot !== undefined) return verifyToken(opts.projectRoot, presented);
  return undefined;
}

export async function createGatewayTransport(
  clientTransport: ClientTransport,
  opts: GatewayOptions,
): Promise<{ close: () => void }> {
  const daemon = await (opts.connectDaemon ?? unixSocketTransport)(opts.socketPath);
  let authedKind: TokenKind | undefined;

  const reject = (id: unknown, r: Rejection): void => {
    if (typeof id === 'number') {
      clientTransport.write(JSON.stringify({ jsonrpc: '2.0', id, error: r }) + '\n');
    }
  };

  /** The line to forward for one client frame, or undefined to drop it. */
  const admit = (line: string): string | undefined => {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return undefined; }
    // Only a single JSON-RPC object is ever forwarded: a batch array or a bare
    // scalar would reach the daemon without passing the method allowlist below.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const msg = parsed as { method?: unknown; id?: unknown; params?: unknown };
    const params = typeof msg.params === 'object' && msg.params !== null
      ? msg.params as Record<string, unknown>
      : undefined;

    if (authedKind === undefined) {
      const kind = authenticate(opts, params?.token ?? params?._token);
      if (kind === undefined) {
        reject(msg.id, { code: -32000, message: 'Unauthorized: gateway token required' });
        return undefined;
      }
      authedKind = kind;
    }
    // Stripped on every frame, not only the first, so the daemon never sees a token.
    if (params) { delete params.token; delete params._token; }

    if (typeof msg.method !== 'string' || !ALLOWED_METHODS.has(msg.method)) {
      reject(msg.id, { code: -32601, message: `Method not found: ${String(msg.method)}` });
      return undefined;
    }
    if (authedKind === 'read' && !READ_METHODS.has(msg.method)) {
      reject(msg.id, { code: -32000, message: `Forbidden: ${msg.method} requires a control token` });
      return undefined;
    }
    // Launch flags become an agent's argv, and an agent flag can run code (Claude's
    // --settings declares hooks): a control token must not amount to a command line.
    if (params !== undefined && 'args' in params) {
      reject(msg.id, { code: -32000, message: 'Forbidden: launch flags can only be set from a local client' });
      return undefined;
    }
    if (opts.projectRoot) appendAudit(opts.projectRoot, { method: msg.method, kind: authedKind });
    return JSON.stringify(msg);
  };

  const onClientData = (chunk: Buffer | string) => {
    let forwarded = '';
    for (const line of chunk.toString().split('\n')) {
      if (!line.trim()) continue;
      const out = admit(line);
      if (out !== undefined) forwarded += out + '\n';
    }
    if (forwarded) daemon.write(forwarded);
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
