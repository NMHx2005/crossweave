import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { CrossweaveError } from '../core/errors.js';
import { assertContained } from '../core/paths.js';
import type { ClientTransport } from '../client/transport.js';
import { createGatewayTransport, type GatewayOptions } from './gateway.js';
import indexHtml from './web/index.htm' with { type: 'text' };
// @ts-expect-error TS1192 — Bun's text import yields this file's SOURCE as a string
// (embedded in the compiled binary); tsc can only see the module itself.
import appSource from './web/app.js' with { type: 'text' };

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
} as const;

let appJs: string | undefined;

/**
 * The built-in web client, for a gateway started without `webRoot`: the page, its
 * script (transpiled from src/gateway/web/app.ts on first request), and a 404 for
 * everything else. The server used to have no request handler at all in that case,
 * so every plain HTTP request — the browser loading the page included — hung.
 */
export function builtInWebResponse(url: string): { status: number; type: string; body: string } {
  const path = url.split('?')[0] ?? '/';
  if (path === '/' || path === '/index.html') {
    return { status: 200, type: 'text/html; charset=utf-8', body: indexHtml };
  }
  if (path === '/app.js') {
    appJs ??= new Bun.Transpiler({ loader: 'ts' }).transformSync(appSource as string);
    return { status: 200, type: 'text/javascript; charset=utf-8', body: appJs };
  }
  return { status: 404, type: 'text/plain; charset=utf-8', body: 'not found' };
}

export interface GatewayServerOptions {
  socketPath: string;
  port: number;
  host?: string;
  cert?: string;
  key?: string;
  allowInsecure?: boolean;
}

export function validateGatewayServerOptions(opts: GatewayServerOptions): void {
  const host = opts.host ?? '127.0.0.1';
  const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
  if (!loopback && !opts.cert && !opts.allowInsecure) {
    throw new CrossweaveError('INVALID_ARGUMENTS', `Gateway bound to ${host} without TLS requires --allow-insecure (and logs loudly)`);
  }
  if ((opts.cert && !opts.key) || (!opts.cert && opts.key)) {
    throw new CrossweaveError('INVALID_ARGUMENTS', 'Both --cert and --key are required for TLS');
  }
}

/**
 * Whether a WebSocket upgrade may proceed, judged by its Origin.
 *
 * WebSocket is exempt from the same-origin policy, so without this any page the
 * user's browser has open could dial ws://127.0.0.1:<port>/ws (or reach it through
 * DNS rebinding) and start guessing at the token. A browser always sends Origin; the
 * only page allowed is one served by this gateway itself. No Origin at all means a
 * non-browser client (the CLI, a script), which the token alone governs.
 */
export function isAllowedOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined || origin === '') return true;
  if (host === undefined || host === '') return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * The file under `webRoot` a request URL names, or undefined when it is missing,
 * a directory, or outside `webRoot`. `join` alone resolved `/../../.crossweave/
 * gateway.token` to the token file itself, which is a control credential.
 */
export function resolveWebPath(webRoot: string, reqUrl: string): string | undefined {
  let urlPath: string;
  try {
    urlPath = decodeURIComponent(reqUrl.split('?')[0] ?? '/');
  } catch {
    return undefined;
  }
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  if (rel.includes('\0')) return undefined;
  let filePath: string;
  try {
    filePath = assertContained(webRoot, rel);
  } catch {
    return undefined;
  }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) return undefined;
  return filePath;
}

interface WsSocket {
  on(ev: 'message', cb: (data: unknown) => void): void;
  on(ev: 'close', cb: () => void): void;
  on(ev: 'error', cb: (err: Error) => void): void;
  send(d: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
}

export async function attachGatewayWs(
  server: ReturnType<typeof createHttpServer>,
  opts: GatewayServerOptions & { projectRoot?: string; connectDaemon?: GatewayOptions['connectDaemon'] },
): Promise<void> {
  // Bun ships `ws` built in, so there is no dependency (and no @types/ws) to import
  // it by name; the non-literal specifier keeps tsc from demanding declarations.
  const { WebSocketServer }: {
    WebSocketServer: new (o: { server: unknown; path: string }) => {
      on(ev: 'connection', cb: (ws: unknown, req: IncomingMessage) => void): void;
    };
  } = await import('ws' as string);
  const wss = new WebSocketServer({ server, path: '/ws' });
  // Tokens are read from disk per connection (via verifyToken), so `cw gateway
  // token --rotate` and `revoke` take effect for the next client without a restart.
  const projectRoot = opts.projectRoot ?? dirname(dirname(opts.socketPath));
  wss.on('connection', (ws: unknown, req: IncomingMessage) => {
    const sock = ws as WsSocket;
    if (!isAllowedOrigin(req.headers.origin, req.headers.host)) {
      sock.close(1008, 'Origin not allowed');
      return;
    }
    const dataSubs: Array<(c: Buffer | string) => void> = [];
    const transport: ClientTransport = {
      write(f: string) { try { sock.send(f); } catch {} },
      onData(cb) { dataSubs.push(cb); },
      onEnd(cb) { sock.on('close', cb); },
      onError(cb) { sock.on('error', cb); },
      onClose(cb) { sock.on('close', cb); },
      isWritable() { return sock.readyState === 1; },
      close() { try { sock.close(); } catch {} },
    };
    sock.on('message', (data: unknown) => { const text = String(data); for (const cb of dataSubs) cb(text); });
    createGatewayTransport(transport, {
      socketPath: opts.socketPath,
      projectRoot,
      ...(opts.connectDaemon ? { connectDaemon: opts.connectDaemon } : {}),
    }).catch(() => sock.close(1011, 'Daemon unreachable'));
  });
}

export function createGatewayHttpServer(opts: GatewayServerOptions & { webRoot?: string }) {
  validateGatewayServerOptions(opts);
  let server;
  if (opts.cert && opts.key) {
    const cert = readFileSync(opts.cert, 'utf8');
    const key = readFileSync(opts.key, 'utf8');
    server = createHttpsServer({ cert, key });
  } else {
    const host = opts.host ?? '127.0.0.1';
    const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
    if (!loopback && opts.allowInsecure) {
      process.stderr.write(`crossweave: gateway on ${host} without TLS (--allow-insecure) — tokens travel cleartext!\n`);
    }
    server = createHttpServer();
  }
  const webRoot = opts.webRoot;
  server.on('request', (req, res) => {
    const url = req.url ?? '/';
    // A WebSocket upgrade never reaches 'request'; a plain GET to /ws is a client
    // that forgot to upgrade and deserves an answer, not a hung connection.
    if (url === '/ws' || url.startsWith('/ws?')) {
      res.writeHead(426, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain', Upgrade: 'websocket' }).end('upgrade required');
      return;
    }
    if (webRoot === undefined) {
      const r = builtInWebResponse(url);
      res.writeHead(r.status, { ...SECURITY_HEADERS, 'Content-Type': r.type }).end(r.body);
      return;
    }
    const filePath = resolveWebPath(webRoot, url);
    if (filePath === undefined) {
      res.writeHead(404, SECURITY_HEADERS).end('not found');
      return;
    }
    const body = readFileSync(filePath);
    const ext = filePath.split('.').pop();
    const ct = ext === 'html' ? 'text/html' : ext === 'js' ? 'application/javascript' : ext === 'css' ? 'text/css' : 'text/plain';
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': ct }).end(body);
  });
  return server;
}
