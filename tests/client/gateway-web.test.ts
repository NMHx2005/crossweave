import { describe, it, expect } from 'bun:test';
import { createWebClient } from '../../src/gateway/web/client.js';
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

describe('web client over gateway transport', () => {
  it('lists sessions and attaches', async () => {
    const clientSide = memoryTransport(); const daemonSide = memoryTransport();
    (clientSide as unknown as { _peer: unknown })._peer = daemonSide; (daemonSide as unknown as { _peer: unknown })._peer = clientSide;
    daemonSide.onData((chunk) => {
      const msg = JSON.parse(chunk.toString().trim()) as { id: number; method: string };
      if (msg.method === 'session.list') daemonSide.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: [{ id: 's1', name: 'alpha' }] }) + '\n');
      else if (msg.method === 'session.attach') daemonSide.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true } }) + '\n');
    });
    const seen: string[] = [];
    const wc = await createWebClient({ transport: clientSide as unknown as ClientTransport, onData: (c) => seen.push(c) });
    const sessions = await wc.client.call('session.list', {});
    expect(sessions).toEqual([{ id: 's1', name: 'alpha' }]);
    await wc.attach('s1');
    // Simulate session.data notification
    daemonSide.write(JSON.stringify({ jsonrpc: '2.0', method: 'session.data', params: { sessionId: 's1', chunk: 'hello' } }) + '\n');
    // Give event loop a tick
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toContain('hello');
  });
});
