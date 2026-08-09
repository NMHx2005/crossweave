import { connect, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CrossweaveError } from '../core/errors.js';
import { crossweaveDir } from '../core/paths.js';
import { createFrameDecoder, encodeFrame } from '../daemon/rpc.js';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export class DaemonClient {
  private nextId = 1;
  private gone = false;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationHandlers: Array<(method: string, params: unknown) => void> = [];
  private readonly closeHandlers: Array<() => void> = [];

  onNotification(cb: (method: string, params: unknown) => void): void {
    this.notificationHandlers.push(cb);
  }

  onClose(cb: () => void): void {
    this.closeHandlers.push(cb);
  }

  private constructor(private readonly socket: Socket) {
    socket.on(
      'data',
      createFrameDecoder((msg) => {
        const r = msg as {
          id?: number;
          method?: string;
          params?: unknown;
          result?: unknown;
          error?: { message: string; data?: { code?: string } };
        };
        if (typeof r.id !== 'number') {
          if (typeof r.method === 'string') {
            for (const h of this.notificationHandlers) h(r.method, r.params);
          }
          return;
        }
        const p = this.pending.get(r.id);
        if (!p) return;
        this.pending.delete(r.id);
        if (r.error) {
          p.reject(new CrossweaveError(r.error.data?.code ?? 'RPC_ERROR', r.error.message));
        } else {
          p.resolve(r.result);
        }
      }),
    );
    // Node THROWS an 'error' event that has no listener, so without this the CLI
    // dies with an uncaught exception when the daemon goes away mid-call instead of
    // the caller getting a clean rejection. `connect` strips its own temporary error
    // listener once connected, which is exactly why one has to be re-registered here.
    socket.on('error', (err: Error) => {
      this.failAll(`Daemon connection failed: ${err.message}`);
    });
    socket.on('close', () => {
      this.failAll('Daemon connection closed');
    });
    // 'end' is the one that actually matters. When the daemon half-closes, no
    // response can ever arrive — but if a write is already stalled in the socket,
    // 'close' never fires and neither does 'error', so without this a pending call
    // hangs forever rather than failing. A hung CLI is worse than a failed one.
    socket.on('end', () => {
      this.failAll('Daemon closed the connection');
    });
  }

  /** True until the connection is known to be gone. */
  get isConnected(): boolean {
    return !this.gone && !this.socket.destroyed && this.socket.writable;
  }

  /**
   * Reject everything in flight and tell anyone watching the connection itself.
   * Idempotent — 'end', 'error' and 'close' overlap, but `closeHandlers` must fire
   * exactly once (an interactive `attach` relies on it to leave raw mode and exit;
   * firing it repeatedly is harmless there but is not a contract worth relying on).
   */
  private failAll(message: string): void {
    const alreadyGone = this.gone;
    this.gone = true;
    for (const p of this.pending.values()) {
      p.reject(new CrossweaveError('DAEMON_GONE', message));
    }
    this.pending.clear();
    if (!alreadyGone) {
      for (const h of this.closeHandlers) h();
    }
  }

  static connect(socketPath: string): Promise<DaemonClient> {
    return new Promise((resolve, reject) => {
      const sock = connect(socketPath);
      sock.once('connect', () => {
        sock.removeAllListeners('error');
        resolve(new DaemonClient(sock));
      });
      sock.once('error', reject);
    });
  }

  call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    // Writing into a socket whose peer is gone succeeds locally and then waits for a
    // response that can never come. Fail fast instead of registering a promise that
    // nothing will ever settle.
    if (!this.isConnected) {
      return Promise.reject(
        new CrossweaveError('DAEMON_GONE', `Daemon connection is gone; cannot call ${method}`),
      );
    }

    const id = this.nextId;
    this.nextId += 1;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.socket.write(encodeFrame({ jsonrpc: '2.0', id, method, params }));
    });
  }

  close(): void {
    this.socket.end();
  }
}

const DAEMON_START_TIMEOUT_MS = 10_000;
const DAEMON_POLL_INTERVAL_MS = 100;

/**
 * `daemonEntry` defaults to the sibling source entry point; Bun runs TypeScript
 * directly, so there is no build step to resolve around. The parameter stays
 * overridable because the compiled single binary (packaging task) spawns the
 * sibling `cwd` executable instead.
 */
export async function connectOrStart(
  projectRoot: string,
  daemonEntry = fileURLToPath(new URL('../daemon/main.ts', import.meta.url)),
): Promise<DaemonClient> {
  const socketPath = join(crossweaveDir(projectRoot), 'daemon.sock');

  try {
    return await DaemonClient.connect(socketPath);
  } catch {
    // Nothing listening; start one below.
  }

  const child = spawn(process.execPath, [daemonEntry], {
    cwd: projectRoot,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      return await DaemonClient.connect(socketPath);
    } catch {
      await new Promise((r) => setTimeout(r, DAEMON_POLL_INTERVAL_MS));
    }
  }

  throw new CrossweaveError(
    'DAEMON_START_FAILED',
    `Daemon did not come up within ${DAEMON_START_TIMEOUT_MS}ms at ${socketPath}`,
  );
}
