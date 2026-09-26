import { describe, it, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { attachGatewayWs, createGatewayHttpServer, isAllowedOrigin, resolveWebPath } from '../../src/gateway/server.js';
import { issueGatewayToken } from '../../src/gateway/auth.js';
import type { ClientTransport } from '../../src/client/transport.js';

describe('isAllowedOrigin', () => {
  it('allows a non-browser client that sends no Origin', () => {
    expect(isAllowedOrigin(undefined, '127.0.0.1:8787')).toBe(true);
  });
  it('allows a page served by the gateway itself', () => {
    expect(isAllowedOrigin('http://127.0.0.1:8787', '127.0.0.1:8787')).toBe(true);
  });
  it('refuses any other page, including another port on the same host', () => {
    expect(isAllowedOrigin('https://evil.example', '127.0.0.1:8787')).toBe(false);
    expect(isAllowedOrigin('http://127.0.0.1:3000', '127.0.0.1:8787')).toBe(false);
    // DNS rebinding: the attacker's name resolves to loopback, but Host carries it too.
    expect(isAllowedOrigin('http://rebind.example:8787', '127.0.0.1:8787')).toBe(false);
  });
  it('refuses a malformed Origin, and an Origin with no Host to compare to', () => {
    expect(isAllowedOrigin('not a url', '127.0.0.1:8787')).toBe(false);
    expect(isAllowedOrigin('http://127.0.0.1:8787', undefined)).toBe(false);
  });
});

describe('resolveWebPath', () => {
  function webRootWithSecretBeside(): { root: string; web: string } {
    const root = mkdtempSync(join(tmpdir(), 'cw-web-'));
    const web = join(root, 'web');
    mkdirSync(join(web, 'assets'), { recursive: true });
    writeFileSync(join(web, 'index.html'), '<html></html>');
    writeFileSync(join(web, 'assets', 'app.js'), '1');
    mkdirSync(join(root, '.crossweave'));
    writeFileSync(join(root, '.crossweave', 'gateway.token'), 'secret');
    return { root, web };
  }

  it('serves index.html for / and files under the root', () => {
    const { root, web } = webRootWithSecretBeside();
    try {
      expect(resolveWebPath(web, '/')).toEndWith('index.html');
      expect(resolveWebPath(web, '/assets/app.js?v=2')).toEndWith(join('assets', 'app.js'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never resolves outside the root — plain or percent-encoded traversal', () => {
    const { root, web } = webRootWithSecretBeside();
    try {
      expect(resolveWebPath(web, '/../.crossweave/gateway.token')).toBeUndefined();
      expect(resolveWebPath(web, '/%2e%2e/.crossweave/gateway.token')).toBeUndefined();
      expect(resolveWebPath(web, '/assets/../../.crossweave/gateway.token')).toBeUndefined();
      expect(resolveWebPath(web, '/%E0%A4%A')).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns undefined for a directory or a missing file', () => {
    const { root, web } = webRootWithSecretBeside();
    try {
      expect(resolveWebPath(web, '/assets')).toBeUndefined();
      expect(resolveWebPath(web, '/nope.js')).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// A real listening gateway. Binds a loopback port, so like every socket test here it
// needs a shell that permits binds.
describe('gateway WebSocket upgrade', () => {
  async function serve(root: string) {
    const daemonSent: string[] = [];
    const fakeDaemon = async (): Promise<ClientTransport> => {
      const dataSubs: Array<(c: Buffer | string) => void> = [];
      return {
        write(f: string) {
          daemonSent.push(f);
          const msg = JSON.parse(f.trim()) as { id: number };
          for (const cb of dataSubs) cb(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: 'ok' }) + '\n');
        },
        onData(cb) { dataSubs.push(cb); },
        onEnd() {}, onError() {}, onClose() {},
        isWritable() { return true; }, close() {},
      };
    };
    const server = createGatewayHttpServer({ socketPath: join(root, '.crossweave', 'daemon.sock'), port: 0 });
    await attachGatewayWs(server, { socketPath: join(root, '.crossweave', 'daemon.sock'), port: 0, projectRoot: root, connectDaemon: fakeDaemon });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    return { port, daemonSent, close: () => new Promise<void>((r) => {
      // close() alone waits on the upgraded sockets, which the http server still counts.
      server.closeAllConnections();
      server.close(() => r());
    }) };
  }

  it('closes a cross-origin browser connection before any frame reaches the daemon', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cw-gw-origin-'));
    const tok = issueGatewayToken(root, 'control');
    const gw = await serve(root);
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/ws`, { headers: { Origin: 'https://evil.example' } } as unknown as string[]);
      const closed = new Promise<number>((r) => ws.addEventListener('close', (e) => r(e.code)));
      ws.addEventListener('open', () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session.list', params: { token: tok } }) + '\n'));
      expect(await closed).toBe(1008);
      expect(gw.daemonSent.length).toBe(0);
    } finally {
      await gw.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('forwards a call from a client with the file-backed token and no Origin', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cw-gw-ok-'));
    const tok = issueGatewayToken(root, 'control');
    const gw = await serve(root);
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/ws`);
      const reply = new Promise<string>((r) => ws.addEventListener('message', (e) => r(String(e.data))));
      ws.addEventListener('open', () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session.list', params: { token: tok } }) + '\n'));
      expect(JSON.parse(await reply)).toMatchObject({ id: 1, result: 'ok' });
      expect(JSON.parse(gw.daemonSent[0]!).params.token).toBeUndefined();
      ws.close();
    } finally {
      await gw.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('gateway HTTP without a webRoot', () => {
  // With no request handler at all, every plain HTTP request hung until the client
  // gave up — including the browser loading the page the gateway exists to serve.
  async function listen() {
    const server = createGatewayHttpServer({ socketPath: '/tmp/none.sock', port: 0 });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    return { port, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
  }
  const get = (port: number, path: string) =>
    fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(2000) });

  it('serves the built-in page and its script', async () => {
    const s = await listen();
    try {
      const page = await get(s.port, '/');
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toContain('text/html');
      expect(await page.text()).toContain('./app.js');
      const app = await get(s.port, '/app.js');
      expect(app.status).toBe(200);
      expect(app.headers.get('content-type')).toContain('javascript');
      const js = await app.text();
      expect(js).toContain('startWebApp');
      expect(js).not.toContain(': string');
      expect(app.headers.get('x-content-type-options')).toBe('nosniff');
    } finally {
      await s.close();
    }
  });

  it('answers anything else with 404 instead of hanging', async () => {
    const s = await listen();
    try {
      expect((await get(s.port, '/nope')).status).toBe(404);
      expect((await get(s.port, '/../.crossweave/gateway.token')).status).toBe(404);
    } finally {
      await s.close();
    }
  });

  it('answers a plain GET to /ws with 426 rather than hanging', async () => {
    const s = await listen();
    try {
      expect((await get(s.port, '/ws')).status).toBe(426);
    } finally {
      await s.close();
    }
  });
});
