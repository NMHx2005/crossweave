import { connect, createServer, type Server, type Socket } from 'node:net';
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { CrossweaveError } from '../core/errors.js';
import {
  createFrameDecoder,
  encodeFrame,
  RPC_ERROR_CODES,
  type RpcResponse,
} from './rpc.js';

export type MethodHandler = (params: Record<string, unknown>) => Promise<unknown> | unknown;

export interface Daemon {
  listen(): Promise<void>;
  close(): Promise<void>;
}

/**
 * True when a daemon is still bound to this socket path. A leftover socket FILE and
 * a live listener are indistinguishable on disk, so the only reliable test is to try
 * to connect: a crashed daemon's file refuses with ECONNREFUSED.
 */
function isSocketLive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(socketPath);
    const settle = (live: boolean): void => {
      probe.removeAllListeners();
      probe.destroy();
      resolve(live);
    };
    probe.once('connect', () => settle(true));
    probe.once('error', () => settle(false));
  });
}

export function createDaemon(opts: {
  socketPath: string;
  methods: Record<string, MethodHandler>;
}): Daemon {
  const sockets = new Set<Socket>();
  let server: Server | undefined;

  function respond(sock: Socket, res: RpcResponse): void {
    if (!sock.destroyed) sock.write(encodeFrame(res));
  }

  async function handle(sock: Socket, msg: unknown): Promise<void> {
    const req = msg as { id?: number; method?: string; params?: Record<string, unknown> };
    const id = typeof req.id === 'number' ? req.id : 0;

    if (typeof req.method !== 'string') {
      respond(sock, {
        jsonrpc: '2.0', id,
        error: { code: RPC_ERROR_CODES.INVALID_REQUEST, message: 'Missing method' },
      });
      return;
    }

    const handler = opts.methods[req.method];
    if (!handler) {
      respond(sock, {
        jsonrpc: '2.0', id,
        error: { code: RPC_ERROR_CODES.METHOD_NOT_FOUND, message: `Unknown method: ${req.method}` },
      });
      return;
    }

    try {
      const result = await handler(req.params ?? {});
      respond(sock, { jsonrpc: '2.0', id, result });
    } catch (err) {
      if (err instanceof CrossweaveError) {
        respond(sock, {
          jsonrpc: '2.0', id,
          error: {
            code: RPC_ERROR_CODES.APPLICATION,
            message: err.message,
            data: { code: err.code },
          },
        });
      } else {
        respond(sock, {
          jsonrpc: '2.0', id,
          error: { code: RPC_ERROR_CODES.INTERNAL, message: (err as Error).message },
        });
      }
    }
  }

  return {
    async listen(): Promise<void> {
      // 0o700: the daemon spawns processes and writes files on the user's behalf,
      // so nothing outside this account may reach its directory or its socket.
      // The chmod is not redundant — `mode` on mkdirSync applies only at creation,
      // and openDatabase has usually made this directory already.
      mkdirSync(dirname(opts.socketPath), { recursive: true, mode: 0o700 });
      chmodSync(dirname(opts.socketPath), 0o700);

      if (existsSync(opts.socketPath)) {
        // Only a socket left by a CRASHED daemon may be removed. Unlinking one a live
        // daemon is still bound to steals its clients while it keeps running with live
        // agent ptys — every session it owns becomes unreachable and neither process
        // is told. Task 11 auto-starts daemons, so this race is reachable.
        if (await isSocketLive(opts.socketPath)) {
          throw new CrossweaveError(
            'DAEMON_ALREADY_RUNNING',
            `Another crossweave daemon is already listening at ${opts.socketPath}`,
          );
        }
        unlinkSync(opts.socketPath);
      }

      const instance = createServer((sock) => {
        sockets.add(sock);
        sock.on('data', createFrameDecoder((msg) => void handle(sock, msg)));
        sock.on('close', () => sockets.delete(sock));
        sock.on('error', () => sockets.delete(sock));
      });
      server = instance;

      return new Promise((resolve, reject) => {
        instance.once('error', reject);
        instance.listen(opts.socketPath, () => {
          // Unix socket permissions follow umask by default, which on many systems
          // leaves the socket group- and world-readable. Anyone able to connect can
          // drive the daemon, so tighten it explicitly rather than trusting umask.
          chmodSync(opts.socketPath, 0o600);
          resolve();
        });
      });
    },

    close(): Promise<void> {
      for (const s of sockets) s.destroy();
      sockets.clear();
      return new Promise((resolve) => {
        if (!server) {
          resolve();
          return;
        }
        server.close(() => {
          if (existsSync(opts.socketPath)) unlinkSync(opts.socketPath);
          server = undefined;
          resolve();
        });
      });
    },
  };
}
