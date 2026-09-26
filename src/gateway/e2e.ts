import { randomBytes, createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto';

/**
 * Derive a 32-byte symmetric key from the per-workspace gateway token.
 * HKDF-SHA256, salt = workspaceId (utf8), info = "crossweave session.data".
 * The token itself is 64 hex chars (32 bytes) stored 0600 under .crossweave/.
 */
export function deriveKey(token: string, workspaceId: string): Buffer {
  // hkdfSync signature: hkdfSync(hash, ikm, salt, info, keylen)
  // Use token as IKM (utf8), workspaceId as salt.
  return Buffer.from(hkdfSync('sha256', Buffer.from(token, 'utf8'), Buffer.from(workspaceId, 'utf8'), Buffer.from('crossweave session.data', 'utf8'), 32));
}

export interface E2EBlob {
  nonce: string; // base64 12B
  ct: string;    // base64
  tag: string;   // base64 16B
}

/**
 * `aad` binds the blob to what it belongs to (the session id). The key is only
 * per-workspace, so without it a relay could move a chunk from one session to
 * another in the same workspace and it would still authenticate.
 */
export function encrypt(plaintext: string, key: Buffer, aad: string): E2EBlob {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { nonce: nonce.toString('base64'), ct: ct.toString('base64'), tag: tag.toString('base64') };
}

export function decrypt(blob: E2EBlob, key: Buffer, aad: string): string {
  const nonce = Buffer.from(blob.nonce, 'base64');
  const ct = Buffer.from(blob.ct, 'base64');
  const tag = Buffer.from(blob.tag, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

