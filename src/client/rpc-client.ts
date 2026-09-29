import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, statSync, truncateSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CrossweaveError } from '../core/errors.js';
import { DAEMON_EXIT_ALREADY_RUNNING } from '../core/exit-codes.js';
import { crossweaveDir } from '../core/paths.js';
import { createFrameDecoder, encodeFrame } from '../daemon/rpc.js';
import { connectablePath } from './socket-path.js';
import { unixSocketTransport, type ClientTransport } from './transport.js';

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
    if (this.gone) {
      cb();
      return;
    }
    this.closeHandlers.push(cb);
  }

  /**
   * Private, and takes a TRANSPORT rather than a socket: the protocol above this line
   * is transport-agnostic (see `src/client/transport.ts`), so a gateway or a browser
   * client builds the same `DaemonClient` over whatever byte path it has. Callers
   * should go through `connect` (unix socket, the only transport shipped today) or
   * `attach` (anything else).
   */
  private constructor(private readonly transport: ClientTransport) {
    transport.onData(
      createFrameDecoder((msg) => {
        this.handleMessage(msg);
      }),
    );
    // A transport-level failure must become a clean rejection for every in-flight
    // call, never an uncaught exception: without this the CLI dies when the daemon
    // goes away mid-call, and every registered `onClose` handler never runs.
    transport.onError((err: Error) => {
      this.failAll(`Daemon connection failed: ${err.message}`);
    });
    transport.onClose(() => {
      this.failAll('Daemon connection closed');
    });
    // 'end' is the one that actually matters. When the daemon half-closes, no
    // response can ever arrive — but if a write is already stalled, neither 'close'
    // nor 'error' fires, so without this a pending call hangs forever rather than
    // failing. A hung CLI is worse than a failed one.
    transport.onEnd(() => {
      this.failAll('Daemon closed the connection');
    });
  }

  /** One decoded frame: a response to a pending call, or a notification. */
  private handleMessage(msg: unknown): void {
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
  }

  /** True until the connection is known to be gone. */
  get isConnected(): boolean {
    return !this.gone && this.transport.isWritable();
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
      for (const h of this.closeHandlers) {
        try {
          h();
        } catch {
          // The handler owns its own failure; every other close handler still fires.
        }
      }
    }
  }

  /** Connect over the local unix socket — the only transport shipped today. */
  static async connect(socketPath: string): Promise<DaemonClient> {
    return new DaemonClient(await unixSocketTransport(connectablePath(socketPath)));
  }

  /**
   * Build a client over any other byte stream (a gateway's WebSocket, a test's
   * in-memory pair). Exported because "the client is transport-agnostic" is only
   * true if there is a supported way to hand it a different transport — the remote
   * work is otherwise forced to fork `connect`.
   */
  static attach(transport: ClientTransport): DaemonClient {
    return new DaemonClient(transport);
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
      this.transport.write(encodeFrame({ jsonrpc: '2.0', id, method, params }));
    });
  }

  close(): void {
    this.transport.close();
  }
}

const DAEMON_START_TIMEOUT_MS = 10_000;
const DAEMON_POLL_INTERVAL_MS = 100;

/** Keep the daemon's own lifecycle log bounded without ever truncating mid-run. */
const DAEMON_LOG_MAX_BYTES = 1_000_000;

/**
 * The fd the spawned daemon writes its stdout/stderr to. Without this, `connectOrStart`
 * used stdio 'ignore' and the daemon's only record of WHY it stopped — its socket being
 * removed or replaced, which hangs up every session's shell — went to /dev/null, and
 * the rows simply read `idle`/`dead` on the next start. `undefined` falls back to
 * 'ignore' when the directory cannot be made.
 */
function openDaemonLog(projectRoot: string): number | undefined {
  try {
    const dir = crossweaveDir(projectRoot);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const logPath = join(dir, 'daemon.log');
    try {
      if (statSync(logPath).size > DAEMON_LOG_MAX_BYTES) truncateSync(logPath, 0);
    } catch {
      // No file yet, or not stat-able: openSync below creates it.
    }
    return openSync(logPath, 'a', 0o600);
  } catch {
    return undefined;
  }
}

/**
 * Compiled binaries run as `cw`; from source, `process.execPath` is the bun binary.
 * The two cases need different daemon entry points and different spawn arguments.
 */
export function resolveDaemonEntry(): { command: string; args: string[] } {
  const isCompiled = basename(process.execPath).startsWith('cw');
  if (isCompiled) {
    return { command: join(dirname(process.execPath), 'cwd'), args: [] };
  }
  return {
    command: process.execPath,
    args: [fileURLToPath(new URL('../daemon/main.ts', import.meta.url))],
  };
}

export async function connectOrStart(
  projectRoot: string,
  entry: { command: string; args: string[]; env?: Record<string, string> } = resolveDaemonEntry(),
): Promise<DaemonClient> {
  const socketPath = join(crossweaveDir(projectRoot), 'daemon.sock');
  // Outside the try: a path that cannot be made connectable is an error to report,
  // not "nothing listening" — which would spawn a daemon per attempt.
  connectablePath(socketPath);

  try {
    return await DaemonClient.connect(socketPath);
  } catch {
    // Nothing listening; start one below.
  }

  const logFd = openDaemonLog(projectRoot);
  const child = spawn(entry.command, entry.args, {
    cwd: projectRoot,
    detached: true,
    // stdout and stderr to the daemon's log: a detached daemon has no terminal, so
    // without this its shutdown reason is lost (see openDaemonLog).
    stdio: logFd === undefined ? 'ignore' : ['ignore', logFd, logFd],
    ...(entry.env === undefined ? {} : { env: { ...process.env, ...entry.env } }),
  });
  // The child holds its own copy of the fd now; the parent's is not needed.
  if (logFd !== undefined) closeSync(logFd);
  // Node reports a spawn failure asynchronously as an 'error' event, and an 'error'
  // with no listener is thrown — an uncaught exception carrying a raw stack trace and
  // internal $bunfs paths, bypassing fail() entirely. Reachable in the ordinary way:
  // a compiled `cw` moved away from its sibling `cwd` binary. Swallowing it here is
  // correct because the polling loop below is what decides the outcome, and it ends
  // in a proper DAEMON_START_FAILED.
  child.on('error', () => undefined);
  // A daemon that exits before it listens will never answer: stop waiting at once —
  // unless it exited BECAUSE another daemon owns the socket (the bind-race loser),
  // in which case the winner is the one to wait for.
  let exitCode: number | null | undefined;
  child.on('exit', (code) => { exitCode = code; });
  child.unref();

  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      return await DaemonClient.connect(socketPath);
    } catch {
      if (exitCode !== undefined && exitCode !== DAEMON_EXIT_ALREADY_RUNNING) {
        // Final attempt: another daemon may still have won the race between our
        // child exiting and this check.
        try {
          return await DaemonClient.connect(socketPath);
        } catch {
          // Genuinely nothing listening.
        }
        throw new CrossweaveError(
          'DAEMON_START_FAILED',
          `crossweave stopped as it started in ${projectRoot} (exit code ${exitCode ?? 'none'})`,
        );
      }
      await new Promise((r) => setTimeout(r, DAEMON_POLL_INTERVAL_MS));
    }
  }

  throw new CrossweaveError(
    'DAEMON_START_FAILED',
    `Daemon did not come up within ${DAEMON_START_TIMEOUT_MS}ms at ${socketPath}`,
  );
}
