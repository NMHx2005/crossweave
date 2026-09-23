import { createHmac, randomBytes, createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto';

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

export function encrypt(plaintext: string, key: Buffer): E2EBlob {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { nonce: nonce.toString('base64'), ct: ct.toString('base64'), tag: tag.toString('base64') };
}

export function decrypt(blob: E2EBlob, key: Buffer): string {
  const nonce = Buffer.from(blob.nonce, 'base64');
  const ct = Buffer.from(blob.ct, 'base64');
  const tag = Buffer.from(blob.tag, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

// Unused helper kept for completeness — not exported to avoid encouraging HMAC misuse.
function _hmac(data: string, key: Buffer): string {
  return createHmac('sha256', key).update(data).digest('hex');
}
void _hmac;
