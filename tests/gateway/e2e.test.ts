import { describe, it, expect } from 'bun:test';
import { deriveKey, encrypt, decrypt } from '../../src/gateway/e2e.js';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('gateway e2e', () => {
  it('round-trip', () => {
    const k = deriveKey('tok123', 'ws1');
    const blob = encrypt('hello world', k);
    expect(decrypt(blob, k)).toBe('hello world');
  });
  it('different key fails', () => {
    const k1 = deriveKey('tok', 'ws1');
    const k2 = deriveKey('tok', 'ws2');
    const blob = encrypt('secret', k1);
    expect(() => decrypt(blob, k2)).toThrow();
  });
  it('empty string round-trip', () => {
    const k = deriveKey('tok', 'ws1');
    const blob = encrypt('', k);
    expect(decrypt(blob, k)).toBe('');
  });
  it('deriveKey is deterministic', () => {
    const a = deriveKey('tok', 'ws1');
    const b = deriveKey('tok', 'ws1');
    expect(a.toString('hex')).toBe(b.toString('hex'));
  });
  it('per-workspace keys differ', () => {
    const k1 = deriveKey('tok', 'ws1');
    const k2 = deriveKey('tok', 'ws2');
    expect(k1.toString('hex')).not.toBe(k2.toString('hex'));
    const blob1 = encrypt('hello', k1);
    expect(() => decrypt(blob1, k2)).toThrow();
    expect(decrypt(blob1, k1)).toBe('hello');
  });
});


describe('rpc-client E2E decrypt routing', () => {
  it('decrypts session.data when projectRootHint matches workspace root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cw-e2e-'));
    try {
      const cwDir = join(root, '.crossweave');
      mkdirSync(cwDir, { recursive: true });
      // Write a gateway token
      const { issueGatewayToken } = await import('../../src/gateway/auth.js');
      const tok = issueGatewayToken(root, 'control');
      const key = deriveKey(tok, root);
      const blob = encrypt('hello via e2e', key);
      // Build a DaemonClient over a fake transport and feed a notification
      const { DaemonClient: DC } = await import('../../src/client/rpc-client.js');
      let transport: any;
      const subs: Array<(c: Buffer|string)=>void> = [];
      transport = {
        write: () => {},
        onData: (cb: (c: Buffer|string)=>void) => subs.push(cb),
        onEnd: () => {}, onError: () => {}, onClose: () => {},
        isWritable: () => true, close: () => {},
        __subs: subs,
      };
      const client = (DC as any).attach(transport as any);
      client.setProjectRoot(root);
      let got: any = undefined;
      client.onNotification((method: string, params: unknown) => {
        if (method === 'session.data') got = params;
      });
      const frame = JSON.stringify({ jsonrpc: '2.0', method: 'session.data', params: { sessionId: 's1', workspaceId: root, chunk: blob } }) + '\n';
      for (const cb of subs) cb(frame);
      // handleMessage is sync via frame decoder — give microtask
      await new Promise((r) => setTimeout(r, 10));
      expect(got).toBeDefined();
      expect((got as any).chunk).toBe('hello via e2e');
      client.close();
    } finally {
      try { rmSync(root, { recursive: true, force: true }); } catch {}
    }
  });
});
