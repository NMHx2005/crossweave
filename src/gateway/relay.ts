import type { ClientTransport } from '../client/transport.js';

/**
 * Stage 3: hosted relay — dumb forwarder between two transports.
 * The relay never inspects session.data content (E2E is between daemon and client);
 * it only forwards frames and preserves ordering. AuthZ stays at the ends.
 */
export interface RelayOptions {
  /** Workspace id for routing (future: multi-workspace relay). */
  workspaceId?: string;
}

export function createRelay(a: ClientTransport, b: ClientTransport, _opts: RelayOptions = {}): { close: () => void } {
  const onA = (chunk: Buffer | string) => b.write(chunk.toString());
  const onB = (chunk: Buffer | string) => a.write(chunk.toString());
  a.onData(onA);
  b.onData(onB);
  const closeBoth = () => { try { a.close(); } catch {} try { b.close(); } catch {} };
  a.onClose(closeBoth); b.onClose(closeBoth);
  a.onEnd(closeBoth); b.onEnd(closeBoth);
  a.onError(closeBoth); b.onError(closeBoth);
  return { close: closeBoth };
}
