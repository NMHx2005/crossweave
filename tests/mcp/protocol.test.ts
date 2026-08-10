import { describe, it, expect } from 'bun:test';
import { framedLines, handleMcpMessage, mcpSocketPath, type McpTool } from '../../src/mcp/protocol.js';

describe('framedLines', () => {
  it('reassembles a message split across chunks', () => {
    const lines: string[] = [];
    const framer = framedLines((line) => lines.push(line));
    framer.feed('{"a":1}\n{"b":');
    framer.feed('2}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('handles multiple messages in one chunk', () => {
    const lines: string[] = [];
    const framer = framedLines((line) => lines.push(line));
    framer.feed('one\ntwo\nthree\n');
    expect(lines).toEqual(['one', 'two', 'three']);
  });

  it('ignores an empty line', () => {
    const lines: string[] = [];
    const framer = framedLines((line) => lines.push(line));
    framer.feed('\n\nreal\n');
    expect(lines).toEqual(['real']);
  });

  it('reassembles a UTF-8 multi-byte character split mid-codepoint across chunks', () => {
    const lines: string[] = [];
    const framer = framedLines((line) => lines.push(line));
    const text = 'nhiệm vụ — 日本語';
    const full = Buffer.from(`${text}\n`, 'utf8');
    // Find a byte offset that falls INSIDE a multi-byte character's encoding: any
    // byte that is not a UTF-8 lead/ASCII byte (i.e. a continuation byte, 10xxxxxx).
    let splitAt = -1;
    for (let i = 0; i < full.length; i++) {
      const byte = full[i];
      if (byte !== undefined && (byte & 0xc0) === 0x80) {
        splitAt = i;
        break;
      }
    }
    expect(splitAt).toBeGreaterThan(0);
    framer.feed(full.subarray(0, splitAt));
    framer.feed(full.subarray(splitAt));
    expect(lines).toEqual([text]);
  });
});

describe('mcpSocketPath', () => {
  it('produces a path comfortably under the AF_UNIX limit', () => {
    const path = mcpSocketPath('s_01kzng781w00005byn0abcdefgh');
    expect(path.length).toBeLessThan(100);
  });

  it('produces distinct paths for distinct session ids', () => {
    expect(mcpSocketPath('s_a')).not.toBe(mcpSocketPath('s_b'));
  });
});

describe('handleMcpMessage', () => {
  const echoTool: McpTool = {
    name: 'echo',
    description: 'Echoes its input',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    handler: async (args) => ({ content: [{ type: 'text', text: String(args.text) }] }),
  };

  it('answers initialize', async () => {
    const response = await handleMcpMessage(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      [echoTool],
    );
    const parsed = JSON.parse(response ?? '') as { result: { serverInfo: { name: string } } };
    expect(parsed.result.serverInfo.name).toBe('crossweave');
  });

  it('answers tools/list with the given tools', async () => {
    const response = await handleMcpMessage(
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      [echoTool],
    );
    const parsed = JSON.parse(response ?? '') as { result: { tools: { name: string }[] } };
    expect(parsed.result.tools.map((t) => t.name)).toEqual(['echo']);
  });

  it('answers tools/call by invoking the matching tool', async () => {
    const response = await handleMcpMessage(
      JSON.stringify({
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'echo', arguments: { text: 'hi' } },
      }),
      [echoTool],
    );
    const parsed = JSON.parse(response ?? '') as { result: { content: { text: string }[] } };
    expect(parsed.result.content[0]?.text).toBe('hi');
  });

  it('tools/call with an unknown tool name returns an MCP-level error, not a crash', async () => {
    const response = await handleMcpMessage(
      JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ghost', arguments: {} } }),
      [echoTool],
    );
    const parsed = JSON.parse(response ?? '') as { result: { isError: boolean } };
    expect(parsed.result.isError).toBe(true);
  });

  it('a notification (no id) gets no response', async () => {
    const response = await handleMcpMessage(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
      [echoTool],
    );
    expect(response).toBeUndefined();
  });

  it('an unknown method returns a JSON-RPC protocol error', async () => {
    const response = await handleMcpMessage(
      JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ghost/method', params: {} }),
      [echoTool],
    );
    const parsed = JSON.parse(response ?? '') as { error: { code: number } };
    expect(parsed.error.code).toBe(-32601);
  });

  it('malformed JSON returns a parse error, not a thrown exception', async () => {
    const response = await handleMcpMessage('{ not json', [echoTool]);
    const parsed = JSON.parse(response ?? '') as { error: { code: number } };
    expect(parsed.error.code).toBe(-32700);
  });

  it('a tool handler that throws is caught and reported as an MCP-level error', async () => {
    const throwingTool: McpTool = {
      name: 'boom',
      description: 'Always throws',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        throw new Error('kaboom');
      },
    };
    const response = await handleMcpMessage(
      JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'boom', arguments: {} } }),
      [throwingTool],
    );
    const parsed = JSON.parse(response ?? '') as { result: { isError: boolean; content: { text: string }[] } };
    expect(parsed.result.isError).toBe(true);
    expect(parsed.result.content[0]?.text).toContain('kaboom');
  });
});
