import { describe, it, expect } from 'bun:test';
import { DeckBridge } from '../../src/deck/bridge.js';
import type { ClientTransport } from '../../src/client/transport.js';

function mem(): ClientTransport & { sent: string[]; _inject: (c: string) => void } {
  const sent: string[] = [];
  const data: Array<(c: Buffer | string) => void> = [];
  const end: Array<() => void> = [], err: Array<(e: Error) => void> = [], close: Array<() => void> = [];
  let w = true;
  let t: ClientTransport & { sent: string[]; _inject: (c: string) => void };
  t = { sent, write(f: string) { sent.push(f); }, onData(cb: (c: Buffer | string) => void) { data.push(cb); }, onEnd(cb: () => void) { end.push(cb); }, onError(cb: (e: Error) => void) { err.push(cb); }, onClose(cb: () => void) { close.push(cb); }, isWritable() { return w; }, close() { w = false; for (const cb of close) cb(); }, _inject(line: string) { for (const cb of data) cb(line); } } as unknown as typeof t & { _inject: (c: string) => void };
  return t;
}

function wire(a: ReturnType<typeof mem>, b: ReturnType<typeof mem>) {
  const aw = a.write.bind(a); const bw = b.write.bind(b);
  (a as unknown as { write: (f: string) => void }).write = (f: string) => { aw(f); b._inject(f); };
  (b as unknown as { write: (f: string) => void }).write = (f: string) => { bw(f); a._inject(f); };
}

describe('DeckBridge', () => {
  it('lists worktrees via session.list — heading is name, colour/dot/selected wired', async () => {
    const clientSide = mem(); const daemonSide = mem();
    wire(clientSide, daemonSide);
    daemonSide.onData((chunk) => {
      const msg = JSON.parse(chunk.toString().trim()) as { id: number };
      daemonSide.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: [{ id: 's1', name: 'feat-x', branch: 'cw/a', worktreePath: '/tmp/wt', status: 'running' }] }) + '\n');
    });
    const bridge = await DeckBridge.connect({ transport: clientSide as unknown as ClientTransport });
    const cards = await bridge.listWorktrees('ws1');
    expect(cards[0]?.heading).toBe('feat-x');
    expect(cards[0]?.branch).toBe('cw/a');
    expect(cards[0]?.selected).toBe(false);
    expect(cards[0]?.dot).toBeDefined();
    expect(cards[0]?.colour).toBeDefined();
  });

  it('waiting maps to amber + needs-you dot', async () => {
    const clientSide = mem(); const daemonSide = mem();
    wire(clientSide, daemonSide);
    daemonSide.onData((chunk) => {
      const msg = JSON.parse(chunk.toString().trim()) as { id: number };
      daemonSide.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: [{ id: 's1', name: 'n', branch: null, worktreePath: null, status: 'waiting' }] }) + '\n');
    });
    const bridge = await DeckBridge.connect({ transport: clientSide as unknown as ClientTransport });
    const cards = await bridge.listWorktrees('ws1');
    expect(cards[0]?.colour).toBe('amber');
    expect(cards[0]?.dot).toBe('needs-you');
  });

  it('resolveFilePath joins worktree + rel, absolute rel strips leading slash', async () => {
    const clientSide = mem();
    const bridge = await DeckBridge.connect({ transport: clientSide as unknown as ClientTransport });
    expect(bridge.resolveFilePath('/tmp/wt', '/tmp/root', 'a/b.ts')).toBe('/tmp/wt/a/b.ts');
    expect(bridge.resolveFilePath(null, '/tmp/root', '/x/y.ts')).toBe('/tmp/root/x/y.ts');
  });

  it('attentionBySession mirrors deriveAttention', async () => {
    const clientSide = mem();
    const bridge = await DeckBridge.connect({ transport: clientSide as unknown as ClientTransport });
    const m = bridge.attentionBySession([{ id: 's1', name: 'a', status: 'waiting' }]);
    expect(m.get('s1')).toBe('needs_you');
  });

  it('latestWords tails', async () => {
    const clientSide = mem();
    const bridge = await DeckBridge.connect({ transport: clientSide as unknown as ClientTransport });
    expect(bridge.latestWords('a b c d e f g', 3)).toBe('e f g');
  });
});
