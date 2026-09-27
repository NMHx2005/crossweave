import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { addDevice, removeDevice } from '../../src/remote/devices.js';
import { ensureTls } from '../../src/remote/cert.js';
import { Hub, type DaemonConn } from '../../src/remote/hub.js';
import { FailureLimiter } from '../../src/remote/limiter.js';
import { Pairing } from '../../src/remote/pairing.js';
import { CrossweaveError } from '../../src/core/errors.js';
import { startRemoteServer, type RunningRemote } from '../../src/remote/server.js';

let home: string;
let running: RunningRemote | undefined;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cw-remote-server-')); });
afterEach(async () => {
  await running?.close();
  running = undefined;
  rmSync(home, { recursive: true, force: true });
});

const fakeConn = (): DaemonConn => ({
  call: async <T>(method: string) => (method === 'session.list' ? [] : { ok: true }) as T,
  onNotification: () => undefined,
  onClose: () => undefined,
  close: () => undefined,
});

async function start(extra: Partial<Parameters<typeof startRemoteServer>[0]> = {}) {
  const hub = new Hub({ connect: async () => ({ conn: fakeConn(), workspaceId: 'w' }) });
  hub.setProjects([{ root: '/repo/a', name: 'a' }]);
  const pairing = new Pairing();
  const peers: Array<Array<{ id: string; name: string }>> = [];
  running = await startRemoteServer({
    listen: [{ reach: 'tailscale', address: '127.0.0.1' }],
    port: 0,
    hub,
    pairing,
    home,
    devicesPollMs: 20,
    onPeers: (list) => peers.push(list),
    ...extra,
  });
  const base = running.urls[0]?.url as string;
  return { hub, pairing, peers, base, origin: base.replace(/\/$/, '') };
}

type Res = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

function raw(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string; ca?: string } = {}): Promise<Res> {
  const u = new URL(url);
  const req = u.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const r = req({ host: u.hostname, port: u.port, path: u.pathname, method: opts.method ?? 'GET', headers: opts.headers, ...(opts.ca ? { ca: opts.ca } : {}) }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    r.on('error', reject);
    if (opts.body !== undefined) r.write(opts.body);
    r.end();
  });
}

type Client = {
  ws: WebSocket;
  call: (method: string, params?: Record<string, unknown>) => Promise<{ result?: unknown; error?: { code: string; message: string } }>;
  sendRaw: (text: string) => void;
  closed: Promise<{ code: number; reason: string }>;
  pushes: Array<{ method: string; params: unknown }>;
};

async function connect(origin: string, headers: Record<string, string> = { Origin: origin }): Promise<Client> {
  const ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/ws`, { headers } as unknown as string[]);
  const pending = new Map<number, (v: { result?: unknown; error?: { code: string; message: string } }) => void>();
  const pushes: Client['pushes'] = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data));
    if (typeof m.id === 'number') pending.get(m.id)?.(m);
    else pushes.push(m);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason })));
  await new Promise<void>((resolve) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('close', () => resolve(), { once: true });
  });
  let next = 1;
  return {
    ws,
    pushes,
    closed,
    sendRaw: (text) => ws.send(text),
    call: (method, params = {}) => new Promise((resolve) => {
      const id = next++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    }),
  };
}

describe('remote server — page and headers', () => {
  it('serves the page with a strict CSP and no framing', async () => {
    const { base } = await start();
    const res = await raw(base);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['cache-control']).toBe('no-store');
    expect((await raw(`${base}app.js`)).headers['content-type']).toContain('javascript');
    expect((await raw(`${base}vendor/xterm.mjs`)).status).toBe(200);
    expect((await raw(`${base}nope`)).status).toBe(404);
    expect((await raw(`${base}../../etc/passwd`)).status).toBe(404);
  });

  it('refuses a request naming another host (DNS rebinding) or origin', async () => {
    const { base } = await start();
    const port = new URL(base).port;
    expect((await raw(base, { headers: { Host: `evil.example:${port}` } })).status).toBe(421);
    expect((await raw(base, { headers: { Host: `localhost:${port}` } })).status).toBe(421);
    expect((await raw(base, { headers: { Origin: 'https://evil.example' } })).status).toBe(421);
  });

  it('never listens on a wildcard address', async () => {
    const hub = new Hub({ connect: async () => ({ conn: fakeConn(), workspaceId: 'w' }) });
    for (const address of ['0.0.0.0', '::', '']) {
      await expect(startRemoteServer({ listen: [{ reach: 'wifi', address }], port: 0, hub, pairing: new Pairing(), home })).rejects.toMatchObject({ code: 'REMOTE_WILDCARD' });
    }
    await expect(startRemoteServer({ listen: [], port: 0, hub, pairing: new Pairing(), home })).rejects.toThrow();
  });

  it('serves HTTPS on the Wi-Fi reach, trusted through the local CA, and offers the CA', async () => {
    const tls = ensureTls('127.0.0.1', { home });
    const { base } = await start({ listen: [{ reach: 'wifi', address: '127.0.0.1' }], tls: () => tls });
    expect(base.startsWith('https://127.0.0.1:')).toBe(true);
    expect(running?.caFingerprint).toBe(tls.caFingerprint);
    const res = await raw(base, { ca: tls.ca });
    expect(res.status).toBe(200);
    const cer = await raw(`${base}ca.cer`, { ca: tls.ca });
    expect(cer.headers['content-type']).toBe('application/x-x509-ca-cert');
  });
});

describe('remote server — pairing', () => {
  const post = (origin: string, body: unknown, headers: Record<string, string> = {}) =>
    raw(`${origin}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify(body) });

  it('turns the code shown on the Mac into a device token, once', async () => {
    const paired: string[] = [];
    const { pairing, origin } = await start({ onPaired: (d) => paired.push(d.name) });
    const { code } = pairing.start();
    const ok = await post(origin, { code, name: 'iPhone' });
    expect(ok.status).toBe(200);
    const body = JSON.parse(ok.body);
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.device.name).toBe('iPhone');
    expect(paired).toEqual(['iPhone']);
    expect((await post(origin, { code, name: 'again' })).status).toBe(403);
  });

  it('refuses a wrong code, a cross-site post, a form post and an oversized body', async () => {
    const { pairing, origin } = await start();
    pairing.start();
    expect((await post(origin, { code: 'ZZZZZZZZZZ' })).status).toBe(403);
    expect((await raw(`${origin}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(400);
    expect((await raw(`${origin}/api/pair`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'code=x' })).status).toBe(400);
    expect((await post(origin, { code: 'x'.repeat(5000) })).status).toBe(413);
  });

  it('shuts out an address after repeated failures', async () => {
    const { pairing, origin } = await start({ limiter: new FailureLimiter({ max: 3 }) });
    pairing.start();
    for (let i = 0; i < 3; i++) await post(origin, { code: 'ZZZZZZZZZZ' });
    expect((await raw(`${origin}/`)).status).toBe(429);
  });
});

describe('remote server — the socket', () => {
  it('signs a paired device in with its first frame and serves the hub', async () => {
    const { origin, peers } = await start();
    const { token, device } = addDevice('iPhone', { home });
    const c = await connect(origin);
    const hello = await c.call('hello', { token });
    expect(hello.result).toEqual({ device: { id: device.id, name: 'iPhone' }, projects: [{ root: '/repo/a', name: 'a' }] });
    expect((await c.call('sessions', { project: '/repo/a' })).result).toEqual({ sessions: [] });
    const refused = await c.call('session.kill', { project: '/repo/a' });
    expect(refused.error?.code).toBe('METHOD_NOT_FOUND');
    expect(peers.at(-1)).toEqual([{ id: device.id, name: 'iPhone' }]);
    c.ws.close();
    await c.closed;
    await new Promise((r) => setTimeout(r, 20));
    expect(peers.at(-1)).toEqual([]);
  });

  it('refuses a socket from another origin, and one with none', async () => {
    const { origin } = await start();
    expect((await (await connect(origin, { Origin: 'https://evil.example' })).closed).code).toBe(1008);
    expect((await (await connect(origin, {})).closed).code).toBe(1008);
  });

  it('refuses a bad token, and anything before signing in', async () => {
    const { origin } = await start();
    const c = await connect(origin);
    const r = await c.call('projects', {});
    expect(r.error?.code).toBe('UNAUTHORIZED');
    expect((await c.closed).code).toBe(4003);
    const d = await connect(origin);
    expect((await d.call('hello', { token: 'x'.repeat(43) })).error?.code).toBe('UNAUTHORIZED');
    expect((await d.closed).code).toBe(4003);
  });

  it('closes a socket that never signs in', async () => {
    const { origin } = await start({ helloTimeoutMs: 30 });
    const c = await connect(origin);
    expect((await c.closed).code).toBe(4001);
  });

  it('closes on an oversized or malformed frame', async () => {
    const { origin } = await start();
    const { token } = addDevice('iPhone', { home });
    const big = await connect(origin);
    await big.call('hello', { token });
    big.sendRaw(JSON.stringify({ id: 9, method: 'send', params: { data: 'x'.repeat(70_000) } }));
    expect((await big.closed).code).toBe(1009);
    const bad = await connect(origin);
    bad.sendRaw('[1,2]');
    expect((await bad.closed).code).toBe(1007);
  });

  it('cuts off a device the moment it is removed on the Mac', async () => {
    const { origin } = await start();
    const { token, device } = addDevice('iPhone', { home });
    const c = await connect(origin);
    await c.call('hello', { token });
    removeDevice(device.id, home);
    expect((await c.closed).code).toBe(4003);
    const again = await connect(origin);
    expect((await again.call('hello', { token })).error?.code).toBe('UNAUTHORIZED');
  });

  it('closes every phone when it stops', async () => {
    const { origin } = await start();
    const { token } = addDevice('iPhone', { home });
    const c = await connect(origin);
    await c.call('hello', { token });
    await running?.close();
    running = undefined;
    expect((await c.closed).code).toBe(4000);
  });

  it('holds at most four sockets per address that have not signed in', async () => {
    const { origin } = await start();
    const waiting = await Promise.all([1, 2, 3, 4].map(() => connect(origin)));
    const fifth = await connect(origin);
    expect((await fifth.closed).code).toBe(1013);
    for (const w of waiting) w.ws.close();
  });

  it('keeps a phone to four sockets, closing its oldest', async () => {
    const { origin } = await start();
    const { token } = addDevice('iPhone', { home });
    const socks: Client[] = [];
    for (let i = 0; i < 5; i++) {
      const c = await connect(origin);
      await c.call('hello', { token });
      socks.push(c);
    }
    expect((await socks[0]!.closed).code).toBe(4009);
    for (const c of socks.slice(1)) c.ws.close();
  });

  it('passes on only daemon errors fit for a phone; the rest say nothing of the Mac', async () => {
    const failing = (code: string, message: string): DaemonConn => ({
      call: async () => { throw new CrossweaveError(code, message); },
      onNotification: () => undefined, onClose: () => undefined, close: () => undefined,
    });
    let next: DaemonConn = failing('WORKTREE_FAILED', 'fatal: /Users/someone/secret/repo: permission denied');
    const hub = new Hub({ connect: async () => ({ conn: next, workspaceId: 'w' }) });
    hub.setProjects([{ root: '/repo/a', name: 'a' }]);
    running = await startRemoteServer({ listen: [{ reach: 'tailscale', address: '127.0.0.1' }], port: 0, hub, pairing: new Pairing(), home });
    const origin = (running.urls[0]?.url as string).replace(/\/$/, '');
    const { token } = addDevice('iPhone', { home });
    const c = await connect(origin);
    await c.call('hello', { token });
    const hidden = await c.call('sessions', { project: '/repo/a' });
    expect(hidden.error).toEqual({ code: 'INTERNAL', message: 'Something went wrong on the Mac' });
    next = failing('SESSION_NOT_FOUND', 'No such session: s_9');
    c.ws.close();
    const d = await connect(origin);
    await d.call('hello', { token });
    expect((await d.call('sessions', { project: '/repo/a' })).error).toEqual({ code: 'SESSION_NOT_FOUND', message: 'No such session: s_9' });
    d.ws.close();
  });
});
