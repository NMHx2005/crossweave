import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { issueGatewayToken, readGatewayToken, revokeGatewayToken, verifyToken } from '../../src/gateway/auth.js';
import { createGatewayTransport } from '../../src/gateway/gateway.js';
import { DaemonClient } from '../../src/client/rpc-client.js';
import type { ClientTransport } from '../../src/client/transport.js';

function memoryTransport(): ClientTransport & { sent: string[] } {
  const sent: string[] = [];
  const dataSubs: Array<(c: Buffer | string) => void> = [];
  const endSubs: Array<() => void> = [], errSubs: Array<(e: Error) => void> = [], closeSubs: Array<() => void> = [];
  let writable = true;
  let t: ClientTransport & { sent: string[]; _peer?: unknown; _inject: (c: string) => void };
  t = { sent, write(f: string) { sent.push(f); const peer = (t as unknown as { _peer?: typeof t })._peer; if (peer) (peer as unknown as { _inject: (c: string) => void })._inject(f); },
    onData(cb: (c: Buffer | string) => void) { dataSubs.push(cb); }, onEnd(cb: () => void) { endSubs.push(cb); }, onError(cb: (e: Error) => void) { errSubs.push(cb); }, onClose(cb: () => void) { closeSubs.push(cb); },
    isWritable() { return writable; }, close() { writable = false; for (const cb of closeSubs) cb(); for (const cb of endSubs) cb(); },
    _inject(line: string) { for (const cb of dataSubs) cb(line); } } as unknown as typeof t & { _peer?: typeof t; _inject: (c: string) => void };
  return t;
}

describe('gateway auth token', () => {
  it('issues, reads and verifies a token, and revokes it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-auth-'));
    // Make it look like a crossweave workspace root (gateway token lives in .crossweave/)
    const root = join(dir, 'ws');
    const { mkdirSync } = require('node:fs');
    mkdirSync(root, { recursive: true });
    // Use a fake projectRoot that has a .crossweave dir — just use dir itself as root and ensure .crossweave exists via issue
    const tok = issueGatewayToken(dir);
    expect(tok.length).toBe(64);
    expect(readGatewayToken(dir)).toBe(tok);
    expect(verifyToken(dir, tok)).toBe('control');
    expect(verifyToken(dir, 'bad')).toBeUndefined();
    expect(revokeGatewayToken(dir)).toBe(true);
    expect(readGatewayToken(dir)).toBeUndefined();
    expect(verifyToken(dir, tok)).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('gateway auth gate', () => {
  it('rejects a call without the token when requireToken is set', async () => {
    const clientSide = memoryTransport(); const gwClient = memoryTransport(); const gwDaemon = memoryTransport();
    (clientSide as unknown as { _peer: unknown })._peer = gwClient; (gwClient as unknown as { _peer: unknown })._peer = clientSide;
    await createGatewayTransport(gwClient as unknown as ClientTransport, { socketPath: '/tmp/fake.sock', requireToken: 'secret123', connectDaemon: async () => gwDaemon as unknown as ClientTransport });
    const client = DaemonClient.attach(clientSide as unknown as ClientTransport);
    await expect(client.call('session.list', {})).rejects.toMatchObject({ message: expect.stringContaining('Unauthorized') });
    expect(gwDaemon.sent.length).toBe(0);
  });

  it('allows a call when the correct token is presented', async () => {
    const clientSide = memoryTransport(); const gwClient = memoryTransport(); const gwDaemon = memoryTransport(); const daemonSide = memoryTransport();
    (clientSide as unknown as { _peer: unknown })._peer = gwClient; (gwClient as unknown as { _peer: unknown })._peer = clientSide;
    (gwDaemon as unknown as { _peer: unknown })._peer = daemonSide; (daemonSide as unknown as { _peer: unknown })._peer = gwDaemon;
    daemonSide.onData((chunk) => {
      const msg = JSON.parse(chunk.toString().trim()) as { id: number };
      daemonSide.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: [] }) + '\n');
    });
    await createGatewayTransport(gwClient as unknown as ClientTransport, { socketPath: '/tmp/fake.sock', requireToken: 'secret123', connectDaemon: async () => gwDaemon as unknown as ClientTransport });
    const client = DaemonClient.attach(clientSide as unknown as ClientTransport);
    const res = await client.call('session.list', { token: 'secret123' });
    expect(res).toEqual([]);
    // Token was stripped before reaching daemon — daemon saw no `token` in params
    const forwarded = JSON.parse(gwDaemon.sent[0]!);
    expect(forwarded.params?.token).toBeUndefined();
  });

  it('READ_METHODS only allows read methods', async () => {
    const { READ_METHODS } = await import('../../src/gateway/auth.js');
    expect(READ_METHODS.has('session.list')).toBe(true);
    expect(READ_METHODS.has('land.session')).toBe(false);
    expect(READ_METHODS.has('session.input')).toBe(false);
    // Reading the journal is a viewer's right; rewriting the pane set another client
    // will restore from is not.
    expect(READ_METHODS.has('journal.get')).toBe(true);
    expect(READ_METHODS.has('journal.set')).toBe(false);
  });
});

// One gateway with a scripted daemon behind it. `daemonSent` is every line the gateway
// forwarded; the fake daemon answers each call with `[]` so an allowed call resolves.
async function gatewayUnder(opts: { requireToken?: string; projectRoot?: string }) {
  const clientSide = memoryTransport(); const gwClient = memoryTransport(); const gwDaemon = memoryTransport(); const daemonSide = memoryTransport();
  (clientSide as unknown as { _peer: unknown })._peer = gwClient; (gwClient as unknown as { _peer: unknown })._peer = clientSide;
  (gwDaemon as unknown as { _peer: unknown })._peer = daemonSide; (daemonSide as unknown as { _peer: unknown })._peer = gwDaemon;
  daemonSide.onData((chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as { id?: number };
      if (typeof msg.id === 'number') daemonSide.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: [] }) + '\n');
    }
  });
  await createGatewayTransport(gwClient as unknown as ClientTransport, { socketPath: '/tmp/fake.sock', ...opts, connectDaemon: async () => gwDaemon as unknown as ClientTransport });
  return { client: DaemonClient.attach(clientSide as unknown as ClientTransport), gwClient, daemonSent: gwDaemon.sent };
}

describe('gateway fails closed', () => {
  it('refuses every call when no token is configured at all, rather than treating the client as control', async () => {
    const { client, daemonSent } = await gatewayUnder({});
    await expect(client.call('session.input', { sessionId: 's1', data: 'echo pwned\n', token: 'anything' }))
      .rejects.toMatchObject({ message: expect.stringContaining('Unauthorized') });
    expect(daemonSent.length).toBe(0);
  });

  it('never forwards an unparseable or non-object line from an unauthenticated client', async () => {
    const { gwClient, daemonSent } = await gatewayUnder({ requireToken: 'secret123' });
    const inject = (gwClient as unknown as { _inject: (c: string) => void })._inject;
    inject('not json\n');
    inject('null\n');
    inject('[{"jsonrpc":"2.0","id":1,"method":"session.kill"}]\n');
    expect(daemonSent.length).toBe(0);
  });

  it('honours the file-backed read token: reads pass, control methods are forbidden', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cw-auth-read-'));
    try {
      issueGatewayToken(root, 'control');
      const readTok = issueGatewayToken(root, 'read');
      const { client, daemonSent } = await gatewayUnder({ projectRoot: root });
      expect(await client.call<unknown[]>('session.list', { token: readTok })).toEqual([]);
      await expect(client.call('session.input', { sessionId: 's1', data: 'x' }))
        .rejects.toMatchObject({ message: expect.stringContaining('Forbidden') });
      expect(daemonSent.length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a wrong file-backed token', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cw-auth-bad-'));
    try {
      issueGatewayToken(root, 'control');
      const { client, daemonSent } = await gatewayUnder({ projectRoot: root });
      await expect(client.call('session.list', { token: 'f'.repeat(64) }))
        .rejects.toMatchObject({ message: expect.stringContaining('Unauthorized') });
      expect(daemonSent.length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
