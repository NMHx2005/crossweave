import { describe, it, expect } from 'bun:test';
import { createRpc, deriveSessionKey, openChunk, tokenFromLocation } from '../../src/gateway/web/app.js';
import { deriveKey, encrypt } from '../../src/gateway/e2e.js';

describe('tokenFromLocation', () => {
  it('prefers the fragment, which never reaches the server', () => {
    expect(tokenFromLocation({ hash: '#token=abc', search: '?token=zzz' })).toBe('abc');
  });
  it('falls back to the query string, and to empty', () => {
    expect(tokenFromLocation({ hash: '', search: '?token=q1' })).toBe('q1');
    expect(tokenFromLocation({ hash: '', search: '' })).toBe('');
  });
});

describe('createRpc', () => {
  it('sends the token with every call and resolves by id', async () => {
    const sent: string[] = [];
    const rpc = createRpc((f) => sent.push(f), 'tok');
    const a = rpc.call<number>('session.list', { workspaceId: 'w' });
    const b = rpc.call<number>('workspace.list');
    const frames = sent.map((f) => JSON.parse(f));
    expect(frames.map((f) => f.params.token)).toEqual(['tok', 'tok']);
    rpc.feed(`${JSON.stringify({ jsonrpc: '2.0', id: frames[1].id, result: 2 })}\n`);
    rpc.feed(`${JSON.stringify({ jsonrpc: '2.0', id: frames[0].id, result: 1 })}\n`);
    expect(await a).toBe(1);
    expect(await b).toBe(2);
  });

  // The gateway forwards daemon socket chunks as they come, so one line can span
  // two WebSocket messages, and one message can hold several lines.
  it('reassembles a line split across messages, and splits several in one', () => {
    const seen: string[] = [];
    const rpc = createRpc(() => undefined, 't');
    rpc.onNotification((m, p) => seen.push(`${m}:${(p as { n: number }).n}`));
    const line = (n: number) => JSON.stringify({ jsonrpc: '2.0', method: 'session.data', params: { n } });
    const one = line(1);
    rpc.feed(one.slice(0, 10));
    expect(seen).toEqual([]);
    rpc.feed(`${one.slice(10)}\n${line(2)}\n${line(3)}\n`);
    expect(seen).toEqual(['session.data:1', 'session.data:2', 'session.data:3']);
  });

  it('rejects with the error code, and fails everything in flight on disconnect', async () => {
    const sent: string[] = [];
    const rpc = createRpc((f) => sent.push(f), 't');
    const bad = rpc.call('session.attach');
    const id = JSON.parse(sent[0]!).id;
    rpc.feed(`${JSON.stringify({ jsonrpc: '2.0', id, error: { message: 'nope', data: { code: 'SESSION_NOT_FOUND' } } })}\n`);
    await expect(bad).rejects.toMatchObject({ message: 'nope', code: 'SESSION_NOT_FOUND' });
    const hung = rpc.call('session.list');
    rpc.failAll('Disconnected');
    await expect(hung).rejects.toThrow('Disconnected');
  });
});

describe('openChunk (WebCrypto) against the daemon\'s sealing (node:crypto)', () => {
  const token = 'a'.repeat(64);
  const root = '/Users/me/repo';

  it('opens a chunk the daemon sealed', async () => {
    const blob = encrypt('hello from the daemon', deriveKey(token, root), 's_1');
    const key = await deriveSessionKey(token, root);
    expect(await openChunk(blob, key, 's_1')).toBe('hello from the daemon');
  });

  it('refuses a chunk moved to another session, or opened with another token', async () => {
    const blob = encrypt('secret', deriveKey(token, root), 's_1');
    expect(await openChunk(blob, await deriveSessionKey(token, root), 's_2')).toBeUndefined();
    expect(await openChunk(blob, await deriveSessionKey('b'.repeat(64), root), 's_1')).toBeUndefined();
  });

  it('passes a plain string through, and cannot open anything without a key', async () => {
    expect(await openChunk('plain', undefined, 's_1')).toBe('plain');
    expect(await openChunk({ nonce: 'x', ct: 'y', tag: 'z' }, undefined, 's_1')).toBeUndefined();
    expect(await openChunk(null, await deriveSessionKey(token, root), 's_1')).toBeUndefined();
  });
});
