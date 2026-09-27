import { createServer as createHttpServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { CrossweaveError } from '../core/errors.js';
import type { Listen } from './addresses.js';
import { ensureTls, type TlsMaterial } from './cert.js';
import { addDevice, devicesStamp, listDevices, touchDevice, verifyDevice, type Device } from './devices.js';
import type { Hub } from './hub.js';
import { FailureLimiter } from './limiter.js';
import type { Pairing } from './pairing.js';
import pageHtml from './web/index.htm' with { type: 'text' };
// @ts-expect-error TS1192 — Bun's text import yields this file's SOURCE (see src/gateway/server.ts)
import pageSource from './web/app.js' with { type: 'text' };
// Served from the Mac itself, never a CDN: another origin could change the code that
// draws every session's output and holds the device token.
// @ts-expect-error TS1192 — a text import of a package file
import xtermJs from '@xterm/xterm/lib/xterm.mjs' with { type: 'text' };
// @ts-expect-error TS2307 — tsc has no module for a stylesheet; Bun reads it as text
import xtermCss from '@xterm/xterm/css/xterm.css' with { type: 'text' };

/**
 * The phone's way in: one listener per reach (plain HTTP on the Tailscale address,
 * HTTPS on the Wi-Fi one), serving the page, the pairing endpoint, and a WebSocket
 * that speaks the hub's API once a device token has been shown.
 */

export type RemoteServerOptions = {
  listen: Listen[];
  port: number;
  hub: Hub;
  pairing: Pairing;
  home?: string;
  tls?: (address: string) => TlsMaterial;
  onPaired?: (device: Device) => void;
  /** The devices connected now, whenever that changes. */
  onPeers?: (devices: Array<{ id: string; name: string }>) => void;
  audit?: (entry: { device?: string; action: string; address?: string }) => void;
  limiter?: FailureLimiter;
  devicesPollMs?: number;
  helloTimeoutMs?: number;
};

export type RunningRemote = {
  urls: Array<{ reach: Listen['reach']; url: string }>;
  caFingerprint: string | undefined;
  close(): Promise<void>;
};

/** Close codes the page explains in words (src/remote/web/app.ts). */
export const CLOSE = { off: 4000, signIn: 4001, notPaired: 4003, blocked: 4029 } as const;

const MAX_FRAME = 64 * 1024;
const MAX_PAIR_BODY = 2048;
/** A phone that cannot keep up with a session's output is cut off rather than buffered without end. */
const MAX_BUFFERED = 8 * 1024 * 1024;

let appJs: string | undefined;

function securityHeaders(origin: string): Record<string, string> {
  const ws = origin.replace(/^http/, 'ws');
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    // No inline script at all: the page holds a device token, so an injected
    // script must have nowhere to run. xterm sets inline styles, hence style-src.
    'Content-Security-Policy': [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      `connect-src 'self' ${ws}`,
      "img-src 'self' data:",
      "font-src 'self'",
      "manifest-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
  };
}

type Asset = { type: string; body: string | Buffer };

function asset(path: string, ca: Buffer | undefined): Asset | undefined {
  switch (path) {
    case '/':
    case '/index.html':
      return { type: 'text/html; charset=utf-8', body: pageHtml };
    case '/app.js':
      appJs ??= new Bun.Transpiler({ loader: 'ts' }).transformSync(pageSource as string);
      return { type: 'text/javascript; charset=utf-8', body: appJs };
    case '/vendor/xterm.mjs':
      return { type: 'text/javascript; charset=utf-8', body: xtermJs as string };
    case '/vendor/xterm.css':
      return { type: 'text/css; charset=utf-8', body: xtermCss as string };
    case '/ca.cer':
      // DER, the form iOS offers to install as a profile.
      return ca === undefined ? undefined : { type: 'application/x-x509-ca-cert', body: ca };
    default:
      return undefined;
  }
}

interface WsSocket {
  on(ev: 'message', cb: (data: unknown) => void): void;
  on(ev: 'close', cb: () => void): void;
  on(ev: 'error', cb: (err: Error) => void): void;
  send(d: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
  bufferedAmount?: number;
}

type WsServerCtor = new (o: { server: Server; path: string }) => {
  on(ev: 'connection', cb: (ws: unknown, req: IncomingMessage) => void): void;
  close(): void;
};

function peerAddress(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

function readBody(req: IncomingMessage, max: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let done = false;
    req.on('data', (c: Buffer) => {
      if (done) return;
      size += c.length;
      // Past the limit nothing more is kept; the caller answers 413 and drops the socket.
      if (size > max) {
        done = true;
        resolve(undefined);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    req.on('error', () => { if (!done) { done = true; resolve(undefined); } });
  });
}

export async function startRemoteServer(opts: RemoteServerOptions): Promise<RunningRemote> {
  if (opts.listen.length === 0) throw new CrossweaveError('REMOTE_NOTHING_TO_LISTEN_ON', 'No address to listen on');
  for (const l of opts.listen) {
    // Belt and braces: listenPlan never produces these, and nothing else may.
    if (l.address === '0.0.0.0' || l.address === '::' || l.address === '') {
      throw new CrossweaveError('REMOTE_WILDCARD', 'The remote server never listens on every address');
    }
  }
  const limiter = opts.limiter ?? new FailureLimiter();
  const tlsFor = opts.tls ?? ((address: string) => ensureTls(address, { home: opts.home }));
  const { WebSocketServer } = await import('ws' as string) as { WebSocketServer: WsServerCtor };

  const servers: Server[] = [];
  const wsServers: Array<{ close(): void }> = [];
  const urls: RunningRemote['urls'] = [];
  let caFingerprint: string | undefined;
  /** Every authenticated socket, by peer id, with the device it belongs to. */
  const sockets = new Map<string, { ws: WsSocket; device: Device }>();

  const reportPeers = (): void => {
    opts.onPeers?.([...sockets.values()].map((s) => ({ id: s.device.id, name: s.device.name })));
  };

  for (const l of opts.listen) {
    const tls = l.reach === 'wifi' ? tlsFor(l.address) : undefined;
    if (tls !== undefined) caFingerprint = tls.caFingerprint;
    const server: Server = tls !== undefined
      ? createHttpsServer({ cert: tls.cert, key: tls.key }) as unknown as Server
      : createHttpServer();
    const scheme = tls !== undefined ? 'https' : 'http';
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(opts.port, l.address, () => { server.off('error', reject); resolve(); });
    });
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    const host = `${l.address}:${port}`;
    const origin = `${scheme}://${host}`;
    urls.push({ reach: l.reach, url: `${origin}/` });
    const headers = securityHeaders(origin);

    /**
     * Host must name this listener exactly: a DNS name pointing here (rebinding) or
     * a guessed IP is refused before anything is served. Origin, when a browser
     * sends one, must be this listener too.
     */
    const allowed = (req: IncomingMessage): boolean =>
      req.headers.host === host && (req.headers.origin === undefined || req.headers.origin === origin);

    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      const address = peerAddress(req);
      if (limiter.isBlocked(address)) {
        res.writeHead(429, { ...headers, 'Content-Type': 'text/plain' }).end('Too many failed attempts — try again in a few minutes');
        return;
      }
      if (!allowed(req)) {
        limiter.fail(address);
        res.writeHead(421, { ...headers, 'Content-Type': 'text/plain' }).end('Unknown host');
        return;
      }
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      if (path === '/api/pair') {
        void pair(req, res, address, headers);
        return;
      }
      if (path === '/ws') {
        res.writeHead(426, { ...headers, 'Content-Type': 'text/plain', Upgrade: 'websocket' }).end('upgrade required');
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { ...headers, 'Content-Type': 'text/plain', Allow: 'GET' }).end('method not allowed');
        return;
      }
      const a = asset(path, tls?.caDer);
      if (a === undefined) {
        res.writeHead(404, { ...headers, 'Content-Type': 'text/plain' }).end('not found');
        return;
      }
      res.writeHead(200, { ...headers, 'Content-Type': a.type }).end(req.method === 'HEAD' ? undefined : a.body);
    });

    const wss = new WebSocketServer({ server, path: '/ws' });
    wsServers.push(wss);
    wss.on('connection', (raw: unknown, req: IncomingMessage) => {
      const ws = raw as WsSocket;
      const address = peerAddress(req);
      if (limiter.isBlocked(address)) {
        ws.close(CLOSE.blocked, 'Too many failed attempts');
        return;
      }
      // A browser always sends Origin on a WebSocket: one that does not match is
      // another page trying this socket, which the same-origin policy does not stop.
      if (req.headers.host !== host || req.headers.origin !== origin) {
        limiter.fail(address);
        ws.close(1008, 'Origin not allowed');
        return;
      }
      serveSocket(ws, address);
    });
  }

  async function pair(req: IncomingMessage, res: ServerResponse, address: string, headers: Record<string, string>): Promise<void> {
    const reply = (status: number, body: unknown): void => {
      res.writeHead(status, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    };
    // A form post from another site carries its own Origin (refused above) or none;
    // demanding JSON and an Origin rules out both a cross-site form and a stray client.
    if (req.method !== 'POST' || req.headers.origin === undefined || !(req.headers['content-type'] ?? '').startsWith('application/json')) {
      reply(400, { error: 'Pair from the page the Mac shows' });
      return;
    }
    const body = await readBody(req, MAX_PAIR_BODY);
    if (body === undefined) {
      res.once('finish', () => req.socket.destroy());
      res.writeHead(413, { ...headers, 'Content-Type': 'application/json', Connection: 'close' }).end(JSON.stringify({ error: 'Too large' }));
      return;
    }
    let parsed: { code?: unknown; name?: unknown } = {};
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      parsed = {};
    }
    const result = opts.pairing.redeem(parsed.code);
    if (result !== 'ok') {
      limiter.fail(address);
      opts.audit?.({ action: `pair-${result}`, address });
      reply(403, { error: result === 'wrong' ? 'That code is not right — check it on the Mac' : 'That code is no longer valid — show a new one on the Mac' });
      return;
    }
    try {
      const { device, token } = addDevice(typeof parsed.name === 'string' ? parsed.name : 'Phone', { home: opts.home });
      opts.audit?.({ device: device.name, action: 'paired', address });
      opts.onPaired?.(device);
      reply(200, { token, device: { id: device.id, name: device.name } });
    } catch (err) {
      reply(409, { error: err instanceof CrossweaveError ? err.message : 'Could not pair' });
    }
  }

  function serveSocket(ws: WsSocket, address: string): void {
    const peerId = randomUUID();
    let device: Device | undefined;
    const send = (msg: unknown): void => {
      if (ws.readyState !== 1) return;
      if ((ws.bufferedAmount ?? 0) > MAX_BUFFERED) {
        ws.close(1013, 'Too slow to keep up');
        return;
      }
      try { ws.send(JSON.stringify(msg)); } catch { /* closed under us */ }
    };
    const helloTimer = setTimeout(() => { if (device === undefined) ws.close(CLOSE.signIn, 'Sign in first'); }, opts.helloTimeoutMs ?? 10_000);

    ws.on('message', (data: unknown) => {
      const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      if (text.length > MAX_FRAME) {
        ws.close(1009, 'Message too large');
        return;
      }
      let msg: { id?: unknown; method?: unknown; params?: unknown };
      try {
        msg = JSON.parse(text) as typeof msg;
      } catch {
        ws.close(1007, 'Not JSON');
        return;
      }
      if (typeof msg !== 'object' || msg === null || Array.isArray(msg) || typeof msg.id !== 'number' || !Number.isSafeInteger(msg.id)) {
        ws.close(1007, 'Not a request');
        return;
      }
      const id = msg.id;
      if (device === undefined) {
        const token = (msg.params as { token?: unknown } | undefined)?.token;
        const found = msg.method === 'hello' ? verifyDevice(token, opts.home) : undefined;
        if (found === undefined) {
          limiter.fail(address);
          opts.audit?.({ action: 'hello-refused', address });
          send({ id, error: { code: 'UNAUTHORIZED', message: 'This phone is not paired, or was removed — pair it again from the Mac' } });
          ws.close(CLOSE.notPaired, 'Not paired');
          return;
        }
        device = found;
        clearTimeout(helloTimer);
        touchDevice(found.id, new Date(), opts.home);
        sockets.set(peerId, { ws, device: found });
        opts.hub.addPeer({ id: peerId, deviceId: found.id, deviceName: found.name, send: (method, params) => send({ method, params }) });
        reportPeers();
        send({ id, result: { device: { id: found.id, name: found.name }, projects: opts.hub.listProjects() } });
        return;
      }
      opts.hub.handle(peerId, msg.method, msg.params).then(
        (result) => send({ id, result }),
        (err: unknown) => send({
          id,
          // A CrossweaveError carries user-facing copy; anything else stays on the Mac.
          error: err instanceof CrossweaveError
            ? { code: err.code, message: err.message }
            : { code: 'INTERNAL', message: 'Something went wrong on the Mac' },
        }),
      );
    });
    const gone = (): void => {
      clearTimeout(helloTimer);
      if (sockets.delete(peerId)) {
        opts.hub.removePeer(peerId);
        reportPeers();
      }
    };
    ws.on('close', gone);
    ws.on('error', gone);
  }

  // A device removed in Settings (or by `cw remote revoke`) is cut off at once, not at
  // its next reconnect: the stamp is one stat, and the list is read only on a change.
  let stamp = devicesStamp(opts.home);
  const poll = setInterval(() => {
    const next = devicesStamp(opts.home);
    if (next === stamp) return;
    stamp = next;
    const present = new Set(listDevices(opts.home).map((d) => d.id));
    for (const { ws, device } of sockets.values()) {
      if (!present.has(device.id)) ws.close(CLOSE.notPaired, 'This phone was removed on the Mac');
    }
  }, opts.devicesPollMs ?? 2000);

  return {
    urls,
    caFingerprint,
    async close(): Promise<void> {
      clearInterval(poll);
      // Said to each phone first, and given a moment to arrive: tearing the servers
      // down at once replaces this close with a bare 1000 the page cannot explain.
      const said = [...sockets.values()].map(({ ws }) => new Promise<void>((resolve) => {
        ws.on('close', () => resolve());
        // 4000, not 1001: Bun reports a 1001 to the client as a plain 1000.
        ws.close(CLOSE.off, 'The Mac turned remote access off');
      }));
      await Promise.race([Promise.all(said), new Promise((r) => setTimeout(r, 500))]);
      sockets.clear();
      opts.hub.close();
      for (const w of wsServers) { try { w.close(); } catch { /* already closed */ } }
      await Promise.all(servers.map((s) => new Promise<void>((resolve) => {
        // Before close(), not after: under Bun, a server whose upgraded sockets are
        // still counted never calls back, and one closed first ignores this call.
        (s as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
        s.close(() => resolve());
      })));
    },
  };
}
