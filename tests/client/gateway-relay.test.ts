import { describe, it, expect } from 'bun:test';
import { createRelay } from '../../src/gateway/relay.js';
import type { ClientTransport } from '../../src/client/transport.js';

function mem(): ClientTransport & { sent: string[] } {
  const sent: string[] = [];
  const data: Array<(c: Buffer | string) => void> = [];
  const end: Array<() => void> = [], err: Array<(e: Error) => void> = [], close: Array<() => void> = [];
  let w = true;
  let t: ClientTransport & { sent: string[]; _inject: (c: string) => void };
  t = { sent, write(f: string) { sent.push(f); }, onData(cb: (c: Buffer | string) => void) { data.push(cb); }, onEnd(cb: () => void) { end.push(cb); }, onError(cb: (e: Error) => void) { err.push(cb); }, onClose(cb: () => void) { close.push(cb); }, isWritable() { return w; }, close() { w = false; for (const cb of close) cb(); }, _inject(line: string) { for (const cb of data) cb(line); } } as unknown as typeof t & { _inject: (c: string) => void };
  return t;
}

describe('relay Stage 3', () => {
  it('forwards frames both ways without inspecting', () => {
    const a = mem(); const b = mem();
    createRelay(a as unknown as ClientTransport, b as unknown as ClientTransport);
    // a.onData -> b.write, b.onData -> a.write; deliver via _inject to simulate inbound
    (a as unknown as { _inject: (c: string) => void })._inject('hello from a\n');
    expect(b.sent).toContain('hello from a\n');
    (b as unknown as { _inject: (c: string) => void })._inject('hello from b\n');
    expect(a.sent).toContain('hello from b\n');
  });
});
