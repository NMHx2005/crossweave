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

describe('createFrameDecoder byte-level robustness', () => {
  // Regression: decoding each chunk independently turns either half of a UTF-8
  // character that straddles a chunk boundary into U+FFFD. The result is still
  // valid JSON, so nothing throws and the payload is silently wrong.
  it('never corrupts a multi-byte character split across chunks', () => {
    const text = 'hello 😀 world 你好 こんにちは';
    const frame = Buffer.from(
      encodeFrame({ jsonrpc: '2.0', id: 1, method: 'x', params: { text } }),
      'utf8',
    );

    // Every possible split point, not just one — the bug only shows at some offsets.
    for (let i = 1; i < frame.length; i += 1) {
      const seen: unknown[] = [];
      const decode = createFrameDecoder((m) => seen.push(m));
      decode(frame.subarray(0, i));
      decode(frame.subarray(i));
      expect(seen).toHaveLength(1);
      expect((seen[0] as { params: { text: string } }).params.text).toBe(text);
    }
  });

  it('discards an over-long line and resynchronises at the next newline', () => {
    const seen: unknown[] = [];
    const decode = createFrameDecoder((m) => seen.push(m));

    decode('x'.repeat(17 * 1024 * 1024));
    expect(seen).toHaveLength(0);

    decode('tail-of-the-oversized-line\n');
    expect(seen).toHaveLength(0);

    decode(encodeFrame({ jsonrpc: '2.0', id: 9, method: 'after' }));
    expect(seen.map((m) => (m as { id: number }).id)).toEqual([9]);
  });
});
