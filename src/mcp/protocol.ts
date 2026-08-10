import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLineFramer } from '../core/framing.js';

export interface McpToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: object;
  handler: (args: Record<string, unknown>) => Promise<McpToolResult>;
}

/**
 * Reassembles a byte stream into newline-delimited messages. A socket delivers
 * data in arbitrary chunks — a message can arrive split across two `data` events,
 * or two messages can arrive in one. This buffers the tail of an incomplete line
 * between calls and calls `onMessage` once per complete line.
 *
 * The reassembly, and the `MAX_LINE_LENGTH` cap that stops an MCP client from
 * growing the daemon's heap by never sending a newline, both live in the shared
 * framer — the same one `src/daemon/rpc.ts` uses, so the two transports cannot end
 * up with different safety properties again.
 */
export function framedLines(onMessage: (line: string) => void): { feed(chunk: Buffer | string): void } {
  const feed = createLineFramer(onMessage);
  return { feed };
}

const SOCKET_PATH_SAFE_MAX = 90; // margin under macOS's ~104 / Linux's ~108 byte AF_UNIX cap

/**
 * A short, stable, collision-free unix socket path for a session's MCP server.
 * Deliberately NOT under the project root — `<projectRoot>/.crossweave/mcp-<id>.sock`
 * routinely exceeds AF_UNIX's path-length limit once a project lives a few
 * directories deep, and a failed bind with no listener crashes the whole process
 * (see Task 8's top-level handler for the last line of defence; this is the first).
 */
export function mcpSocketPath(sessionId: string): string {
  const full = join(tmpdir(), `cw-mcp-${sessionId}.sock`);
  if (full.length <= SOCKET_PATH_SAFE_MAX) return full;
  // Fallback for an unusually long $TMPDIR or session id: a short stable hash still
  // guarantees no two sessions collide, just without the id being human-readable.
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
  return join(tmpdir(), `cw-mcp-${hash}.sock`);
}

const PROTOCOL_VERSION = '2024-11-05';

function ok(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function protocolError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

/**
 * Parses and dispatches one JSON-RPC 2.0 line. Returns the response line to write
 * back, or `undefined` for a notification (no `id`), which gets no response per
 * the JSON-RPC spec. Never throws — every failure mode (bad JSON, unknown method,
 * a tool handler that throws) becomes a JSON-RPC or MCP-level error response
 * instead, so one malformed message can never take down the connection.
 */
export async function handleMcpMessage(raw: string, tools: McpTool[]): Promise<string | undefined> {
  let msg: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    msg = JSON.parse(raw) as typeof msg;
  } catch {
    return protocolError(null, -32700, 'Parse error');
  }

  const { id, method, params } = msg;
  const isNotification = id === undefined;

  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'crossweave', version: '0.0.0' },
    });
  }

  if (method === 'notifications/initialized') {
    return undefined; // acknowledged implicitly by continuing to serve requests
  }

  if (method === 'tools/list') {
    return ok(id, {
      tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    });
  }

  if (method === 'tools/call') {
    const name = typeof params?.name === 'string' ? params.name : undefined;
    const args = (params?.arguments ?? {}) as Record<string, unknown>;
    const tool = tools.find((t) => t.name === name);
    if (tool === undefined) {
      if (isNotification) return undefined;
      return ok(id, { content: [{ type: 'text', text: `Unknown tool: ${String(name)}` }], isError: true });
    }
    try {
      const result = await tool.handler(args);
      if (isNotification) return undefined;
      return ok(id, result);
    } catch (err) {
      if (isNotification) return undefined;
      const text = err instanceof Error ? err.message : String(err);
      return ok(id, { content: [{ type: 'text', text }], isError: true });
    }
  }

  if (isNotification) return undefined;
  return protocolError(id, -32601, `Method not found: ${String(method)}`);
}
