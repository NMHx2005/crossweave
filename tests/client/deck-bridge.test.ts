import { describe, it, expect } from 'bun:test';
import { DeckBridge } from '../../src/deck/bridge.js';
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

describe('DeckBridge', () => {
  it('lists worktrees via session.list', async () => {
    const clientSide = mem(); const daemonSide = mem();
    // Wire: client writes land on daemon, daemon replies land on client — connect via _peer _inject already wired as write->peer
    // For this minimal test, patch write to also deliver to peer's data
    const origClientWrite = clientSide.write.bind(clientSide);
    const origDaemonWrite = daemonSide.write.bind(daemonSide);
    (clientSide as unknown as { write: (f: string) => void }).write = (f: string) => { origClientWrite(f); (daemonSide as unknown as { _inject: (c: string) => void })._inject(f); };
    (daemonSide as unknown as { write: (f: string) => void }).write = (f: string) => { origDaemonWrite(f); (clientSide as unknown as { _inject: (c: string) => void })._inject(f); };
    daemonSide.onData((chunk) => {
      const msg = JSON.parse(chunk.toString().trim()) as { id: number };
      daemonSide.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: [{ id: 's1', branch: 'cw/a', worktreePath: '/tmp/wt', status: 'running' }] }) + '\n');
    });
    const bridge = await DeckBridge.connect({ transport: clientSide as unknown as ClientTransport });
    const cards = await bridge.listWorktrees('ws1');
    expect(cards[0]?.branch).toBe('cw/a');
  });
});
