import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { framedLines, handleMcpMessage, mcpSocketPath, type McpTool } from './protocol.js';

/**
 * Current claim holder per socket path, process-wide.
 *
 * Ownership used to be decided by comparing inode numbers (statSync at bind
 * time vs. at close time), but that has two problems: an inode is only
 * unique among files that exist at the same time — not a stable identity
 * across a delete then a fresh create at the same path, and on Linux tmpfs
 * (where `os.tmpdir()` usually lands) a freed inode can be handed straight
 * back out to the very next file created there. And bind time itself is too
 * late: the underlying socket file can already exist on disk before the
 * `'listening'` event fires, so a concurrent close() elsewhere could still
 * race it. `createMcpServer()` claims its token here synchronously, before
 * any async bind/close work starts — JS is single-threaded, so two calls can
 * never interleave, and whichever call happened last deterministically holds
 * the claim, regardless of how their async bind/close operations resolve.
 */
const socketOwners = new Map<string, object>();

export interface McpServerHandle {
  socketPath: string;
  /**
   * True only once the underlying `net.Server` has actually bound the socket —
   * i.e. its `'listening'` event fired. A handle can exist (this function never
   * throws on a bind failure — see below) while this stays permanently `false`,
   * which is exactly the case a caller needs to distinguish "server object was
   * created" from "socket is actually reachable".
   */
  listening(): boolean;
  /**
   * Resolves once the initial bind attempt has settled — `true` on success,
   * `false` on failure. Never rejects, and never hangs: `listen()`'s `'listening'`
   * and `'error'` events are the only two outcomes of a bind attempt, and exactly
   * one of them always fires. A caller that needs `listening()` to be accurate
   * (rather than possibly still "hasn't bound yet") must await this first.
   */
  ready(): Promise<boolean>;
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
  // Claimed synchronously, before any async bind/close work starts — see
  // `socketOwners`'s doc comment. `createMcpServer()` calls can't interleave
  // with each other (JS is single-threaded), so whichever call happens last
  // wins the claim deterministically, regardless of how the two instances'
  // async bind/close operations end up racing afterward.
  const myToken = {};
  socketOwners.set(socketPath, myToken);

  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch {
      // Best effort — a stale socket file from a previous run.
    }
  }

  // Tracked so `close()` can force every open connection shut: `netServer.close()`'s
  // callback only fires once ALL accepted connections have ended on their own, and
  // an MCP client holds its connection open for the session's whole life — without
  // this, `close()` would hang forever in the steady state instead of resolving.
  const openSockets = new Set<Socket>();

  const netServer: NetServer = createServer((socket: Socket) => {
    socket.on('error', () => {
      // A peer that goes away mid-write is not this process's problem.
    });

    openSockets.add(socket);
    socket.on('close', () => {
      openSockets.delete(socket);
    });

    const framer = framedLines((line) => {
      void handleMcpMessage(line, tools)
        .then((response) => {
          if (response !== undefined && !socket.destroyed) {
            socket.write(response + '\n');
          }
        })
        .catch((err: unknown) => {
          // handleMcpMessage is documented never to throw, but `ok()`/`protocolError()`
          // JSON.stringify caller-supplied data outside any try/catch — if that ever
          // rejects, it must not become an unhandled rejection that kills the daemon.
          // Logged rather than swallowed: the client is left waiting forever on that
          // request id, so a real bug here must leave a trace somewhere.
          process.stderr.write(
            `crossweave: MCP message handling failed for session ${sessionId}: ${String(err)}\n`,
          );
        });
    });

    socket.on('data', (chunk) => framer.feed(chunk));
  });

  let bound = false;
  let settleReady: (v: boolean) => void = () => undefined;
  const readyPromise = new Promise<boolean>((resolve) => {
    settleReady = resolve;
  });

  netServer.on('error', (err) => {
    process.stderr.write(`crossweave: MCP server for session ${sessionId} failed: ${String(err)}\n`);
    settleReady(false);
  });

  netServer.listen(socketPath, () => {
    bound = true;
    try {
      chmodSync(socketPath, 0o600);
    } catch {
      // Best effort — the socket still works even if the mode couldn't be tightened.
    }
    settleReady(true);
  });

  /** Removes the socket file only while it is still the one this server bound. */
  function unlinkOwnSocketFile(): void {
    if (!bound) return; // Never actually bound: nothing here is ours to reclaim.
    if (socketOwners.get(socketPath) !== myToken) return; // A newer server claimed this name since.
    socketOwners.delete(socketPath);
    try {
      unlinkSync(socketPath);
    } catch {
      // Best effort on close.
    }
  }

  return {
    socketPath,
    listening(): boolean {
      return bound;
    },
    ready(): Promise<boolean> {
      return readyPromise;
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        for (const socket of openSockets) {
          socket.destroy();
        }

        const finish = (): void => {
          unlinkOwnSocketFile();
          resolve();
        };

        // If the initial bind never succeeded, `netServer.close()` throws
        // ERR_SERVER_NOT_RUNNING synchronously instead of reporting it through the
        // callback — guard on `.listening` so a failed-to-bind session's `close()`
        // still resolves instead of crashing the caller.
        if (!netServer.listening) {
          finish();
          return;
        }
        netServer.close(() => finish());
      });
    },
  };
}
