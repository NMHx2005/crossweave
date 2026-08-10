import { createLineFramer } from '../core/framing.js';

interface RpcRequest {
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
 * JSON framing on top of the shared line framer (`src/core/framing.ts`), which owns
 * the UTF-8 chunk reassembly and the max-line-length cap that keeps an unterminated
 * line from exhausting memory.
 */
export function createFrameDecoder(
  onMessage: (msg: unknown) => void,
): (chunk: Buffer | string) => void {
  return createLineFramer((line) => {
    try {
      onMessage(JSON.parse(line));
    } catch {
      // A malformed line is dropped; the stream stays usable.
    }
  });
}
