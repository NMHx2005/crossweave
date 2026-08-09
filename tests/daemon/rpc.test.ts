import { describe, it, expect } from 'bun:test';
import { encodeFrame, createFrameDecoder, RPC_ERROR_CODES } from '../../src/daemon/rpc.js';

describe('encodeFrame', () => {
  it('emits one newline-terminated JSON line', () => {
    const s = encodeFrame({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(s.endsWith('\n')).toBe(true);
    expect(s.split('\n')).toHaveLength(2);
    expect(JSON.parse(s.trim())).toEqual({ jsonrpc: '2.0', id: 1, method: 'ping' });
  });
});

describe('createFrameDecoder', () => {
  it('decodes a single frame', () => {
    const seen: unknown[] = [];
    const decode = createFrameDecoder((m) => seen.push(m));
    decode(encodeFrame({ jsonrpc: '2.0', id: 1, method: 'ping' }));
    expect(seen).toHaveLength(1);
  });

  it('decodes frames split across chunk boundaries', () => {
    const seen: unknown[] = [];
    const decode = createFrameDecoder((m) => seen.push(m));
    const frame = encodeFrame({ jsonrpc: '2.0', id: 7, method: 'x' });
    decode(frame.slice(0, 5));
    expect(seen).toHaveLength(0);
    decode(frame.slice(5));
    expect(seen).toHaveLength(1);
    expect((seen[0] as { id: number }).id).toBe(7);
  });

  it('decodes several frames arriving in one chunk', () => {
    const seen: unknown[] = [];
    const decode = createFrameDecoder((m) => seen.push(m));
    decode(
      encodeFrame({ jsonrpc: '2.0', id: 1, method: 'a' }) +
        encodeFrame({ jsonrpc: '2.0', id: 2, method: 'b' }),
    );
    expect(seen.map((m) => (m as { id: number }).id)).toEqual([1, 2]);
  });

  it('skips a malformed line without throwing and keeps decoding', () => {
    const seen: unknown[] = [];
    const decode = createFrameDecoder((m) => seen.push(m));
    decode('{not json}\n' + encodeFrame({ jsonrpc: '2.0', id: 3, method: 'c' }));
    expect(seen.map((m) => (m as { id: number }).id)).toEqual([3]);
  });

  it('ignores blank lines', () => {
    const seen: unknown[] = [];
    const decode = createFrameDecoder((m) => seen.push(m));
    decode('\n\n' + encodeFrame({ jsonrpc: '2.0', id: 4, method: 'd' }));
    expect(seen).toHaveLength(1);
  });
});

describe('RPC_ERROR_CODES', () => {
  it('uses the standard JSON-RPC codes', () => {
    expect(RPC_ERROR_CODES.METHOD_NOT_FOUND).toBe(-32601);
    expect(RPC_ERROR_CODES.APPLICATION).toBe(-32000);
  });
});
