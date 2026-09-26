import { statSync } from 'node:fs';
import { deriveKey, encrypt } from './e2e.js';
import { readGatewayToken, tokenPath } from './auth.js';

/**
 * Seals one chunk of a session's output for the wire.
 *
 * Returns the chunk unchanged while the workspace has no gateway token (nothing but
 * local clients can connect then — the gateway refuses everyone without one), an
 * E2E blob once it has one, and `undefined` — drop the chunk — when sealing was
 * required or could not be ruled out but failed. Falling back to plaintext there is
 * exactly the leak E2E exists to prevent.
 */
export type ChunkSealer = (chunk: string, session: { id: string; workspaceId: string }) => unknown;

export function createChunkSealer(rootFor: (workspaceId: string) => string): ChunkSealer {
  // Keyed by root; `stamp` is the token file's mtime+size. Checking it per chunk is
  // one stat, and it is what lets a token issued (or rotated) after the daemon
  // started take effect — deciding once at boot left such a daemon in plaintext.
  const cache = new Map<string, { stamp: string; key: Buffer | undefined }>();

  function keyFor(root: string): Buffer | undefined {
    let stamp: string;
    try {
      const st = statSync(tokenPath(root, 'control'));
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      stamp = 'none';
    }
    const hit = cache.get(root);
    if (hit?.stamp === stamp) return hit.key;
    const token = stamp === 'none' ? undefined : readGatewayToken(root, 'control');
    if (stamp !== 'none' && token === undefined) throw new Error('gateway token unreadable');
    const key = token === undefined ? undefined : deriveKey(token, root);
    cache.set(root, { stamp, key });
    return key;
  }

  return (chunk, session) => {
    try {
      const key = keyFor(rootFor(session.workspaceId));
      return key === undefined ? chunk : encrypt(chunk, key, session.id);
    } catch {
      return undefined;
    }
  };
}
