import { describe, it, expect } from 'bun:test';
import { DaemonClient } from '../../src/client/rpc-client.js';
import type { ClientTransport } from '../../src/client/transport.js';

/**
 * The point of the seam, stated as a test: the whole client — request multiplexing,
 * the pending map, notification fan-out, fail-fast on half-close — runs over ANY byte
 * stream. This is the property a gateway (unix socket on one side, WebSocket on the
 * other) and a browser client depend on, and it is asserted here rather than assumed
 * because a client that secretly needs `node:net` would only be discovered while
 * building the gateway.
 */
class MemoryTransport implements ClientTransport {
  readonly sent: string[] = [];
  private writable = true;
  private readonly dataSubs: Array<(chunk: Buffer | string) => void> = [];
  private readonly endSubs: Array<() => void> = [];
  private readonly errorSubs: Array<(err: Error) => void> = [];
  private readonly closeSubs: Array<() => void> = [];

  write(frame: string): void {
    this.sent.push(frame);
  }
  onData(cb: (chunk: Buffer | string) => void): void {
    this.dataSubs.push(cb);
  }
  onEnd(cb: () => void): void {
    this.endSubs.push(cb);
  }
  onError(cb: (err: Error) => void): void {
    this.errorSubs.push(cb);
  }
  onClose(cb: () => void): void {
    this.closeSubs.push(cb);
  }
  isWritable(): boolean {
    return this.writable;
  }
  close(): void {
    this.writable = false;
  }

  // --- test-side controls ---
  /** Deliver one server frame the way a real transport would: as bytes. */
  deliver(msg: unknown): void {
    for (const cb of this.dataSubs) cb(`${JSON.stringify(msg)}\n`);
  }
  /** Deliver a frame SPLIT across two chunks — sockets split anywhere. */
  deliverSplit(msg: unknown): void {
    const text = `${JSON.stringify(msg)}\n`;
    for (const cb of this.dataSubs) cb(text.slice(0, 7));
    for (const cb of this.dataSubs) cb(text.slice(7));
  }
  fail(err: Error): void {
    this.writable = false;
    for (const cb of this.errorSubs) cb(err);
  }
  halfClose(): void {
    this.writable = false;
    for (const cb of this.endSubs) cb();
  }
}

describe('DaemonClient over a non-socket transport', () => {
  it('sends an encoded frame and resolves on the matching response', async () => {
    const t = new MemoryTransport();
    const client = DaemonClient.attach(t);
    const pending = client.call<{ ok: boolean }>('ping');
    expect(t.sent).toHaveLength(1);
    const sent = JSON.parse(t.sent[0]!) as { id: number; method: string };
    expect(sent.method).toBe('ping');
    t.deliver({ jsonrpc: '2.0', id: sent.id, result: { ok: true } });
    expect(await pending).toEqual({ ok: true });
  });

  it('multiplexes concurrent calls and routes each response by id', async () => {
    const t = new MemoryTransport();
    const client = DaemonClient.attach(t);
    const first = client.call<string>('a');
    const second = client.call<string>('b');
    const ids = t.sent.map((f) => (JSON.parse(f) as { id: number }).id);
    expect(new Set(ids).size).toBe(2);
    // Answer out of order: the client must match on id, not on arrival.
    t.deliver({ jsonrpc: '2.0', id: ids[1], result: 'B' });
    t.deliver({ jsonrpc: '2.0', id: ids[0], result: 'A' });
    expect(await first).toBe('A');
    expect(await second).toBe('B');
  });

  it('reassembles a frame split across two chunks', async () => {
    const t = new MemoryTransport();
    const client = DaemonClient.attach(t);
    const pending = client.call<number>('n');
    const id = (JSON.parse(t.sent[0]!) as { id: number }).id;
    t.deliverSplit({ jsonrpc: '2.0', id, result: 7 });
    expect(await pending).toBe(7);
  });

  it('delivers a notification (no id) to onNotification', () => {
    const t = new MemoryTransport();
    const client = DaemonClient.attach(t);
    const seen: Array<[string, unknown]> = [];
    client.onNotification((method, params) => seen.push([method, params]));
    t.deliver({ jsonrpc: '2.0', method: 'tui.invalidate', params: {} });
    expect(seen).toEqual([['tui.invalidate', {}]]);
  });

  it('turn a transport error into a clean rejection, never an uncaught throw', async () => {
    const t = new MemoryTransport();
    const client = DaemonClient.attach(t);
    let closes = 0;
    client.onClose(() => { closes += 1; });
    const pending = client.call('ping');
    t.fail(new Error('websocket closed abruptly'));
    await expect(pending).rejects.toMatchObject({ code: 'DAEMON_GONE' });
    expect(closes).toBe(1);
    // Fail-fast afterwards, rather than queueing a call nothing can satisfy.
    await expect(client.call('ping')).rejects.toMatchObject({ code: 'DAEMON_GONE' });
    expect(client.isConnected).toBe(false);
  });

  it('treats a half-close as fatal, because no response can ever arrive', async () => {
    const t = new MemoryTransport();
    const client = DaemonClient.attach(t);
    const pending = client.call('ping');
    t.halfClose();
    await expect(pending).rejects.toMatchObject({ code: 'DAEMON_GONE' });
  });

  it('fires onClose immediately when registered after the transport is gone', () => {
    const t = new MemoryTransport();
    const client = DaemonClient.attach(t);
    t.halfClose();
    let closed = false;
    client.onClose(() => { closed = true; });
    expect(closed).toBe(true);
  });
});
