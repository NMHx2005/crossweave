import { describe, it, expect } from 'bun:test';
import { ALLOWED_METHODS, createGatewayTransport } from '../../src/gateway/gateway.js';
import { DaemonClient } from '../../src/client/rpc-client.js';
import type { ClientTransport } from '../../src/client/transport.js';

function memoryTransport(): ClientTransport & { deliver: (msg: unknown) => void; sent: string[] } {
  const sent: string[] = [];
  const dataSubs: Array<(c: Buffer | string) => void> = [];
  const endSubs: Array<() => void> = [], errSubs: Array<(e: Error) => void> = [], closeSubs: Array<() => void> = [];
  let writable = true;
  const t: ClientTransport & { deliver: (msg: unknown) => void; sent: string[] } = {
    sent,
    write(f: string) { sent.push(f); for (const s of (t as unknown as { _peer?: typeof t })._peer ? [((t as unknown as { _peer: typeof t })._peer)] : []) s && (s as unknown as { _inject: (c: string) => void })._inject(f); },
    onData(cb: (c: Buffer | string) => void) { dataSubs.push(cb); }, onEnd(cb: () => void) { endSubs.push(cb); }, onError(cb: (e: Error) => void) { errSubs.push(cb); }, onClose(cb: () => void) { closeSubs.push(cb); },
    isWritable() { return writable; }, close() { writable = false; for (const cb of closeSubs) cb(); for (const cb of endSubs) cb(); },
    deliver(msg: unknown) { const line = `${JSON.stringify(msg)}\n`; for (const cb of dataSubs) cb(line); },
    _inject(line: string) { for (const cb of dataSubs) cb(line); },
  } as unknown as typeof t & { _peer?: typeof t; _inject: (c: string) => void };
  return t;
}

describe('gateway Stage 0', () => {
  it('shuttles a call through the gateway to the daemon and back', async () => {
    const clientSide = memoryTransport();
    const gatewayClientSide = memoryTransport();
    const gatewayDaemonSide = memoryTransport();
    const daemonSide = memoryTransport();
    (clientSide as unknown as { _peer: unknown })._peer = gatewayClientSide;
    (gatewayClientSide as unknown as { _peer: unknown })._peer = clientSide;
    (gatewayDaemonSide as unknown as { _peer: unknown })._peer = daemonSide;
    (daemonSide as unknown as { _peer: unknown })._peer = gatewayDaemonSide;
    daemonSide.onData((chunk) => {
      const text = chunk.toString().trim();
      if (!text) return;
      const msg = JSON.parse(text) as { id: number };
      daemonSide.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: [{ id: '1', name: 'alice' }] }) + '\n');
    });
    await createGatewayTransport(gatewayClientSide as unknown as ClientTransport, {
      socketPath: '/tmp/fake.sock',
      connectDaemon: async () => gatewayDaemonSide as unknown as ClientTransport,
    });
    const client = DaemonClient.attach(clientSide as unknown as ClientTransport);
    const result = await client.call('session.list', { workspaceId: 'w1' });
    expect(result).toEqual([{ id: '1', name: 'alice' }]);
  });

  it('rejects an unknown method without forwarding', async () => {
    const clientSide = memoryTransport();
    const gatewayClientSide = memoryTransport();
    const gatewayDaemonSide = memoryTransport();
    // Link clientSide <-> gatewayClientSide, gatewayDaemonSide is isolated (should receive nothing for unknown)
    (clientSide as unknown as { _peer: unknown })._peer = gatewayClientSide;
    (gatewayClientSide as unknown as { _peer: unknown })._peer = clientSide;
    const daemonSent: string[] = [];
    const origWrite = gatewayDaemonSide.write.bind(gatewayDaemonSide);
    gatewayDaemonSide.write = (f: string) => { daemonSent.push(f); origWrite(f); };
    await createGatewayTransport(gatewayClientSide as unknown as ClientTransport, {
      socketPath: '/tmp/fake.sock',
      connectDaemon: async () => gatewayDaemonSide as unknown as ClientTransport,
    });
    const client = DaemonClient.attach(clientSide as unknown as ClientTransport);
    const pending = client.call('evil.method', {});
    await expect(pending).rejects.toMatchObject({ message: expect.stringContaining('Method not found') });
    expect(daemonSent.length).toBe(0);
  });

  it('allows known methods', () => {
    expect(ALLOWED_METHODS.has('session.list')).toBe(true);
    expect(ALLOWED_METHODS.has('evil.method')).toBe(false);
  });
});
