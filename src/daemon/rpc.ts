import { StringDecoder } from 'node:string_decoder';

export interface RpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: RpcError;
}

export const RPC_ERROR_CODES = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INTERNAL: -32603,
  APPLICATION: -32000,
} as const;

export function encodeFrame(msg: RpcRequest | RpcResponse): string {
  return `${JSON.stringify(msg)}\n`;
}

/**
 * Bounds an UNTERMINATED line that keeps growing — the memory-exhaustion vector,
 * since the daemon accepts connections. It does NOT bound a complete oversized frame
 * that arrives with its own newline: the loop drains that as an ordinary line before
 * the length check runs. Set far above any legitimate frame; session scrollback and
 * diffs are the largest payloads.
 */
const MAX_LINE_LENGTH = 16 * 1024 * 1024;

export function createFrameDecoder(
  onMessage: (msg: unknown) => void,
): (chunk: Buffer | string) => void {
  /**
   * `StringDecoder` carries partial multi-byte state between calls. Calling
   * `chunk.toString('utf8')` per chunk instead decodes each half of a UTF-8
   * character split across a chunk boundary independently, baking U+FFFD into the
   * payload: still valid JSON, silently wrong content, and no error to catch. Real
   * sockets split anywhere, so this is reachable in normal operation.
   */
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let discarding = false;

  return (chunk) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);

    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (discarding) {
        discarding = false; // This newline ends the over-long line we dropped.
      } else if (line.length > 0) {
        try {
          onMessage(JSON.parse(line));
        } catch {
          // A malformed line is dropped; the stream stays usable.
        }
      }
      index = buffer.indexOf('\n');
    }

    if (buffer.length > MAX_LINE_LENGTH) {
      buffer = '';
      discarding = true;
    }
  };
}
