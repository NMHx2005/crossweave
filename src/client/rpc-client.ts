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
  private readonly pending = new Map<number, Pending>();

  private constructor(private readonly socket: Socket) {
    socket.on(
      'data',
      createFrameDecoder((msg) => {
        const r = msg as {
          id?: number;
          result?: unknown;
          error?: { message: string; data?: { code?: string } };
        };
        if (typeof r.id !== 'number') return;
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
    socket.on('close', () => {
      for (const p of this.pending.values()) {
        p.reject(new CrossweaveError('DAEMON_GONE', 'Daemon connection closed'));
      }
      this.pending.clear();
    });
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
