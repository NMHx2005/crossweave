import { describe, it, expect } from 'bun:test';
import { deriveKey, encrypt, decrypt } from '../../src/gateway/e2e.js';
import { createChunkSealer } from '../../src/gateway/e2e-sealer.js';
import { issueGatewayToken, revokeGatewayToken } from '../../src/gateway/auth.js';
import { DaemonClient } from '../../src/client/rpc-client.js';
import type { ClientTransport } from '../../src/client/transport.js';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('gateway e2e', () => {
  it('round-trip', () => {
    const k = deriveKey('tok123', 'ws1');
    const blob = encrypt('hello world', k, 's1');
    expect(decrypt(blob, k, 's1')).toBe('hello world');
  });
  it('different key fails', () => {
    const k1 = deriveKey('tok', 'ws1');
    const k2 = deriveKey('tok', 'ws2');
    const blob = encrypt('secret', k1, 's1');
    expect(() => decrypt(blob, k2, 's1')).toThrow();
  });
  it('empty string round-trip', () => {
    const k = deriveKey('tok', 'ws1');
    const blob = encrypt('', k, 's1');
    expect(decrypt(blob, k, 's1')).toBe('');
  });
  it('deriveKey is deterministic', () => {
    const a = deriveKey('tok', 'ws1');
    const b = deriveKey('tok', 'ws1');
    expect(a.toString('hex')).toBe(b.toString('hex'));
  });
  it('binds the session id: a chunk moved to another session does not decrypt', () => {
    const k = deriveKey('tok', 'ws1');
    const blob = encrypt('for s1 only', k, 's1');
    expect(() => decrypt(blob, k, 's2')).toThrow();
  });
  it('per-workspace keys differ', () => {
    const k1 = deriveKey('tok', 'ws1');
    const k2 = deriveKey('tok', 'ws2');
    expect(k1.toString('hex')).not.toBe(k2.toString('hex'));
    const blob1 = encrypt('hello', k1, 's1');
    expect(() => decrypt(blob1, k2, 's1')).toThrow();
    expect(decrypt(blob1, k1, 's1')).toBe('hello');
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
      const blob = encrypt('hello via e2e', key, 's1');
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

describe('createChunkSealer', () => {
  const session = { id: 's1', workspaceId: 'w1' };

  it('passes plaintext through while the workspace has no gateway token', () => {
    const root = mkdtempSync(join(tmpdir(), 'cw-seal-none-'));
    try {
      const seal = createChunkSealer(() => root);
      expect(seal('plain', session)).toBe('plain');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('starts sealing as soon as a token is issued, without a daemon restart', () => {
    const root = mkdtempSync(join(tmpdir(), 'cw-seal-late-'));
    try {
      const seal = createChunkSealer(() => root);
      expect(seal('before', session)).toBe('before');
      const tok = issueGatewayToken(root, 'control');
      const blob = seal('after', session) as { nonce: string; ct: string; tag: string };
      expect(typeof blob).toBe('object');
      expect(decrypt(blob, deriveKey(tok, root), 's1')).toBe('after');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('follows a rotation to the new key', () => {
    const root = mkdtempSync(join(tmpdir(), 'cw-seal-rot-'));
    try {
      const seal = createChunkSealer(() => root);
      issueGatewayToken(root, 'control');
      seal('warm the cache', session);
      revokeGatewayToken(root, 'control');
      const tok2 = issueGatewayToken(root, 'control');
      const blob = seal('rotated', session) as { nonce: string; ct: string; tag: string };
      expect(decrypt(blob, deriveKey(tok2, root), 's1')).toBe('rotated');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('drops the chunk rather than sending plaintext when the workspace cannot be resolved', () => {
    const seal = createChunkSealer(() => { throw new Error('no such workspace'); });
    expect(seal('secret output', session)).toBeUndefined();
  });
});

describe('DaemonClient with an undecryptable chunk', () => {
  function fakeTransport(): ClientTransport & { push: (frame: unknown) => void } {
    const subs: Array<(c: Buffer | string) => void> = [];
    return {
      write: () => {}, onData: (cb) => { subs.push(cb); }, onEnd: () => {}, onError: () => {}, onClose: () => {},
      isWritable: () => true, close: () => {},
      push(frame: unknown) { for (const cb of subs) cb(JSON.stringify(frame) + '\n'); },
    };
  }

  it('surfaces one visible notice per session instead of silently dropping output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cw-e2e-fail-'));
    try {
      const key = deriveKey(issueGatewayToken(root, 'control'), root);
      const t = fakeTransport();
      const client = DaemonClient.attach(t);
      // No root hint: this client has no way to find the key.
      const got: Array<{ chunk: unknown; decryptFailed?: boolean }> = [];
      client.onNotification((m, p) => { if (m === 'session.data') got.push(p as { chunk: unknown; decryptFailed?: boolean }); });
      const blob = encrypt('secret', key, 's1');
      t.push({ jsonrpc: '2.0', method: 'session.data', params: { sessionId: 's1', workspaceId: 'w1', chunk: blob } });
      t.push({ jsonrpc: '2.0', method: 'session.data', params: { sessionId: 's1', workspaceId: 'w1', chunk: blob } });
      await new Promise((r) => setTimeout(r, 10));
      expect(got.length).toBe(1);
      expect(got[0]!.decryptFailed).toBe(true);
      expect(typeof got[0]!.chunk).toBe('string');
      expect(got[0]!.chunk as string).toContain('could not decrypt');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('DaemonClient with sealed terminal output', () => {
  // Terminal panes' output is sealed like session.data, bound to the terminal id.
  it('opens terminal.data with the terminal id as AAD', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cw-e2e-term-'));
    try {
      const key = deriveKey(issueGatewayToken(root, 'control'), root);
      const subs: Array<(c: Buffer | string) => void> = [];
      const t: ClientTransport = {
        write: () => {}, onData: (cb) => { subs.push(cb); }, onEnd: () => {}, onError: () => {}, onClose: () => {},
        isWritable: () => true, close: () => {},
      };
      const client = DaemonClient.attach(t);
      client.setProjectRoot(root);
      const got: unknown[] = [];
      client.onNotification((m, p) => { if (m === 'terminal.data') got.push((p as { chunk: unknown }).chunk); });
      const frame = { jsonrpc: '2.0', method: 'terminal.data', params: { terminalId: 't_1', sessionId: 's_1', workspaceId: 'w', chunk: encrypt('$ ls\r\n', key, 't_1') } };
      for (const cb of subs) cb(JSON.stringify(frame) + '\n');
      await new Promise((r) => setTimeout(r, 10));
      expect(got).toEqual(['$ ls\r\n']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
