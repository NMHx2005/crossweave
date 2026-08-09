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

export function createFrameDecoder(
  onMessage: (msg: unknown) => void,
): (chunk: Buffer | string) => void {
  let buffer = '';
  return (chunk) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) {
        try {
          onMessage(JSON.parse(line));
        } catch {
          // A malformed line is dropped; the stream stays usable.
        }
      }
      index = buffer.indexOf('\n');
    }
  };
}
