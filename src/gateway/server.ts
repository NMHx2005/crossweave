import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { CrossweaveError } from '../core/errors.js';

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

export async function attachGatewayWs(server: ReturnType<typeof createHttpServer>, opts: GatewayServerOptions) {
  // Lazy import ws to avoid hard dep when not serving
  let WebSocketServer: unknown;
  try { WebSocketServer = (await import('ws' as unknown as string)).WebSocketServer; } catch { return; }
  const wss = new (WebSocketServer as unknown as { new(opts: { server: unknown; path: string }): { on: (ev: string, cb: (ws: unknown) => void) => void } })({ server, path: '/ws' });
  const { createGatewayTransport } = await import('./gateway.js');
  const { readGatewayToken } = await import('./auth.js');
  wss.on('connection', async (ws: unknown) => {
    const sock = ws as { on: (ev: string, cb: (data: unknown) => void) => void; send: (d: string) => void; close: () => void; readyState: number };
    // Build a ClientTransport over this WS
    const dataSubs: Array<(c: Buffer | string) => void> = [];
    const transport = {
      write(f: string) { try { sock.send(f); } catch {} },
      onData(cb: (c: Buffer | string) => void) { dataSubs.push(cb); },
      onEnd(cb: () => void) {}, onError(cb: (e: Error) => void) {}, onClose(cb: () => void) { sock.on('close', () => cb()); },
      isWritable() { return true; }, close() { try { sock.close(); } catch {} },
    };
    sock.on('message', (data: unknown) => { const text = String(data); for (const cb of dataSubs) cb(text); });
    const base = opts.socketPath.replace('/.crossweave/daemon.sock','');
  const token = readGatewayToken(base, 'control') ?? readGatewayToken(base);
    await createGatewayTransport(transport as unknown as import('../client/transport.js').ClientTransport, { socketPath: opts.socketPath, requireToken: token ?? undefined, projectRoot: base });
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
  if (opts.webRoot) {
    const { existsSync, readFileSync: rf, statSync } = require('node:fs');
    const { join } = require('node:path');
    server.on('request', (req, res) => {
      if (!req.url || req.url.startsWith('/ws')) return;
      const urlPath = req.url.split('?')[0] ?? '/';
      const filePath = join(opts.webRoot!, urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, ''));
      if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
        res.writeHead(404).end('not found');
        return;
      }
      const body = rf(filePath);
      const ext = filePath.split('.').pop();
      const ct = ext === 'html' ? 'text/html' : ext === 'js' ? 'application/javascript' : ext === 'css' ? 'text/css' : 'text/plain';
      res.writeHead(200, { 'Content-Type': ct }).end(body);
    });
  }
  return server;
}
