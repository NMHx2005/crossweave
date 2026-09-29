import type { DaemonClient } from '../client/rpc-client.js';

/**
 * Ask the running cockpit to do something, through the daemon's bridge. The building block
 * for `cw pane` and `cw browser`; they choose the kind, the params and how long to wait (a
 * kind that waits on a person passes a longer `timeoutMs` than the cockpit's own confirmation).
 * A failure is a CrossweaveError whose code (BRIDGE_NO_COCKPIT, BRIDGE_TIMEOUT, …) `fail()`
 * prints as the one `CODE: message` line every command uses.
 */
export function bridgeCall<T = unknown>(
  client: DaemonClient,
  workspaceId: string,
  kind: string,
  params: unknown = {},
  timeoutMs?: number,
): Promise<T> {
  return client.call<T>('bridge.call', { workspaceId, kind, params, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
}
