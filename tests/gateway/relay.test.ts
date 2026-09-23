import { describe, it, expect } from 'bun:test';
import { createRelay } from '../../src/gateway/relay.js';
import type { ClientTransport } from '../../src/client/transport.js';

function mem(): ClientTransport & { inject: (c: string) => void; sent: string[] } {
  const data: Array<(c: Buffer | string) => void> = [];
  const sent: string[] = [];
  const t = {
    write(f: string) { sent.push(f); },
    onData(cb: (c: Buffer | string) => void) { data.push(cb); },
    onEnd(_cb: () => void) {},
    onError(_cb: (e: Error) => void) {},
    onClose(_cb: () => void) {},
    isWritable() { return true; },
    close() {},
    inject(c: string) { for (const cb of data) cb(c); },
    sent,
  } as unknown as ClientTransport & { inject: (c: string) => void; sent: string[] };
  return t;
}

describe('relay dumb forwarder', () => {
  it('forwards both ways, preserves ordering', () => {
    const a = mem();
    const b = mem();
    createRelay(a as unknown as ClientTransport, b as unknown as ClientTransport);
    a.inject('hello');
    expect(b.sent).toEqual(['hello']);
    b.inject('world');
    expect(a.sent).toEqual(['world']);
  });
});
