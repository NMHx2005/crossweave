import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { framedLines, handleMcpMessage, mcpSocketPath, type McpTool } from './protocol.js';

export interface McpServerHandle {
  socketPath: string;
  close(): Promise<void>;
}

/**
 * Starts a per-session MCP server on a unix domain socket. Both the listening
 * server and every accepted connection get an `'error'` listener attached before
 * anything else happens to them — an unlistened `'error'` event on a `node:net`
 * object throws by default, and with no top-level handler in the daemon process
 * (added separately in `src/daemon/main.ts`) that throw would kill the whole
 * daemon, not just this one session's server. A bind failure here is caught,
 * logged, and left as "this session has no MCP tools available" — degraded, not
 * catastrophic.
 */
export function createMcpServer(
  sessionId: string,
  tools: McpTool[],
): McpServerHandle {
  const socketPath = mcpSocketPath(sessionId);
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch {
      // Best effort — a stale socket file from a previous run.
    }
  }

  const netServer: NetServer = createServer((socket: Socket) => {
    socket.on('error', () => {
      // A peer that goes away mid-write is not this process's problem.
    });

    const framer = framedLines((line) => {
      void handleMcpMessage(line, tools).then((response) => {
        if (response !== undefined && !socket.destroyed) {
          socket.write(response + '\n');
        }
      });
    });

    socket.on('data', (chunk) => framer.feed(chunk));
  });

  netServer.on('error', (err) => {
    process.stderr.write(`crossweave: MCP server for session ${sessionId} failed: ${String(err)}\n`);
  });

  netServer.listen(socketPath, () => {
    try {
      chmodSync(socketPath, 0o600);
    } catch {
      // Best effort — the socket still works even if the mode couldn't be tightened.
    }
  });

  return {
    socketPath,
    close(): Promise<void> {
      return new Promise((resolve) => {
        netServer.close(() => {
          if (existsSync(socketPath)) {
            try {
              unlinkSync(socketPath);
            } catch {
              // Best effort on close.
            }
          }
          resolve();
        });
      });
    },
  };
}
