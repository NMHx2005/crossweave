import { createRelay, type RelayOptions } from './relay.js';
import type { ClientTransport } from '../client/transport.js';

/**
 * Minimal Worker entry for hosted relay — routing by workspaceId query.
 * Real deploy uses Cloudflare Worker `fetch` + WebSocket upgrade.
 * Stub for spec: pairs two ClientTransports via createRelay.
 */
export function handleRelayUpgrade(a: ClientTransport, b: ClientTransport, opts: RelayOptions): { close: () => void } {
  return createRelay(a, b, opts);
}
