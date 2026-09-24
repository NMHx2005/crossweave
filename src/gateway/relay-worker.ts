import { createRelay, type RelayOptions } from './relay.js';
import type { ClientTransport } from '../client/transport.js';

/**
 * Minimal Worker entry for hosted relay — routing by workspaceId query/header.
 * Real deploy: Cloudflare Worker `fetch` event upgrades to WebSocket, then pairs
 * with a second WS (or daemon side) via createRelay. Presence via closeBoth.
 * This stub pairs two ClientTransports and exposes the same contract for tests.
 */
export function handleRelayUpgrade(a: ClientTransport, b: ClientTransport, opts: RelayOptions): { close: () => void } {
  return createRelay(a, b, opts);
}

/**
 * Workspace routing helper — extracts workspaceId from URL query/header.
 * No auth at relay; ALLOWED_METHODS enforced at ends.
 */
export function extractWorkspaceId(url: string, headers?: Record<string, string>): string | undefined {
  try {
    const u = new URL(url, 'http://dummy');
    const q = u.searchParams.get('workspaceId') ?? u.searchParams.get('workspace_id');
    if (q) return q;
    if (headers) {
      const h = headers['x-workspace-id'] ?? headers['X-Workspace-Id'] ?? headers['workspaceId'];
      if (h) return h;
    }
  } catch {}
  return undefined;
}
