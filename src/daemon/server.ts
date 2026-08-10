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

export interface MethodContext {
  notify(method: string, params: unknown): void;
  onClose(cb: () => void): void;
}

export type MethodHandler = (
  params: Record<string, unknown>,
  ctx: MethodContext,
) => Promise<unknown> | unknown;

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

/** One bind attempt, as a promise that rejects with the raw errno error. */
function bindOnce(instance: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      instance.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      instance.removeListener('error', onError);
      resolve();
    };
    instance.once('error', onError);
    instance.once('listening', onListening);
    instance.listen(socketPath);
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

  async function handle(sock: Socket, msg: unknown, ctx: MethodContext): Promise<void> {
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
      const result = await handler(req.params ?? {}, ctx);
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

      const instance = createServer((sock) => {
        sockets.add(sock);
        const closeCallbacks: Array<() => void> = [];
        const ctx: MethodContext = {
          notify(method, params) {
            if (!sock.destroyed) {
              sock.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
            }
          },
          onClose(cb) {
            closeCallbacks.push(cb);
          },
        };
        const cleanup = (): void => {
          sockets.delete(sock);
          for (const cb of closeCallbacks) cb();
          closeCallbacks.length = 0;
        };
        sock.on('data', createFrameDecoder((msg) => void handle(sock, msg, ctx)));
        sock.on('close', cleanup);
        sock.on('error', cleanup);
      });
      server = instance;

      // Bind FIRST and recover, rather than checking the path and then acting on it.
      // `bind()` is atomic in the kernel, so it — not us — decides who owns the
      // socket. Checking `isSocketLive` before unlinking left a window where two
      // starting daemons could each conclude "it's dead" and both unlink and bind,
      // which is the same silent-steal outcome in a narrower form. `listen` reports
      // EADDRINUSE identically for a live socket, a stale socket, and a plain file,
      // so there is no cheaper signal being given up here.
      try {
        await bindOnce(instance, opts.socketPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;

        // Something holds the path. Only crash debris may be cleared: if a daemon
        // answers, it owns the socket and taking it would orphan its live sessions.
        if (await isSocketLive(opts.socketPath)) {
          throw new CrossweaveError(
            'DAEMON_ALREADY_RUNNING',
            `Another crossweave daemon is already listening at ${opts.socketPath}`,
          );
        }

        unlinkSync(opts.socketPath);
        try {
          await bindOnce(instance, opts.socketPath);
        } catch (retry) {
          if ((retry as NodeJS.ErrnoException).code === 'EADDRINUSE') {
            // Another starter won between our unlink and our retry. Losing this way
            // is safe and retryable — it never steals a socket.
            throw new CrossweaveError(
              'DAEMON_ALREADY_RUNNING',
              `Another crossweave daemon took ${opts.socketPath} first`,
            );
          }
          throw retry;
        }
      }

      // Unix socket permissions follow umask by default, which on many systems
      // leaves the socket group- and world-readable. Anyone able to connect can
      // drive the daemon, so tighten it explicitly rather than trusting umask.
      chmodSync(opts.socketPath, 0o600);
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
