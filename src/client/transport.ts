import { connect } from 'node:net';

/**
 * The byte-stream seam under `DaemonClient`.
 *
 * The daemon's protocol is newline-delimited JSON-RPC (`src/daemon/rpc.ts`), and that
 * is a property of the FRAMING, not of the socket: the same frames travel over a unix
 * socket, a TCP connection, a WebSocket, or an SSH stdio pair. Only the path the bytes
 * take differs — so that path is the only thing behind this interface.
 *
 * It exists so remote/web access is "write one more implementation of this", not
 * "fork the client": a gateway that re-exposes the daemon over WebSocket, or a browser
 * client speaking WebSocket directly, reuses `DaemonClient` — request multiplexing,
 * the pending map, notification fan-out, and the fail-fast-on-half-close behaviour all
 * come along unchanged.
 *
 * What it deliberately does NOT abstract: authentication, encryption, or where the
 * daemon lives. Today the trust boundary is the OS user account, enforced by the
 * socket's file permissions (`0600` in a `0700` directory). Any transport that leaves
 * the machine must bring its own authn/authz with it — see
 * `docs/superpowers/specs/2026-09-18-client-seam-and-remote.md`.
 */
export interface ClientTransport {
  /** Send one already-encoded frame. */
  write(frame: string): void;
  /** Subscribe to inbound bytes. May be called before the peer says anything. */
  onData(cb: (chunk: Buffer | string) => void): void;
  /**
   * The peer half-closed. Distinct from `onClose` on purpose: when the peer is gone
   * but a write is still buffered, `close` never fires and neither does `error`, so
   * this is the only signal that a pending response can no longer arrive. Dropping it
   * is how a client hangs forever instead of failing.
   */
  onEnd(cb: () => void): void;
  onError(cb: (err: Error) => void): void;
  onClose(cb: () => void): void;
  /** False once a write can no longer reach the peer. */
  isWritable(): boolean;
  /** Half-close politely. Safe to call more than once. */
  close(): void;
}

/** Deliver to every subscriber, and never let one throw stop the others. */
function fanOut<T>(subs: ReadonlyArray<(v: T) => void>, value: T): void {
  for (const cb of subs) {
    try {
      cb(value);
    } catch {
      // The subscriber owns its failure; the stream keeps going.
    }
  }
}

/**
 * The local transport: a unix domain socket at the daemon's path.
 *
 * Every listener is registered HERE, at construction, rather than by each subscriber —
 * a Node EventEmitter with no 'error' listener throws, and the window between "the
 * socket connected" and "the client finished subscribing" is exactly when that would
 * bite. Attaching once, up front, removes the window instead of narrowing it.
 */
export function unixSocketTransport(socketPath: string): Promise<ClientTransport> {
  return new Promise<ClientTransport>((resolve, reject) => {
    const sock = connect(socketPath);
    const dataSubs: Array<(chunk: Buffer | string) => void> = [];
    const endSubs: Array<() => void> = [];
    const errorSubs: Array<(err: Error) => void> = [];
    const closeSubs: Array<() => void> = [];

    sock.on('data', (chunk: Buffer) => fanOut(dataSubs, chunk));
    sock.on('end', () => fanOut(endSubs, undefined));
    sock.on('error', (err: Error) => fanOut(errorSubs, err));
    sock.on('close', () => fanOut(closeSubs, undefined));

    sock.once('connect', () => {
      resolve({
        write: (frame) => {
          sock.write(frame);
        },
        onData: (cb) => dataSubs.push(cb),
        onEnd: (cb) => endSubs.push(cb),
        onError: (cb) => errorSubs.push(cb),
        onClose: (cb) => closeSubs.push(cb),
        isWritable: () => !sock.destroyed && sock.writable,
        close: () => {
          sock.end();
        },
      });
    });
    // Pre-connect only. Before this resolves there is no client to fail, so the
    // connection attempt itself rejecting is the whole contract — and the permanent
    // 'error' listener above means the fan-out is already covered either way.
    sock.once('error', reject);
  });
}
