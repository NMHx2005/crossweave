import { describe, expect, test } from 'bun:test';
import { BROWSER_COMMANDS, decide, type AccessLevel, type BrowserCommand } from '../../../src/core/browser-agent/permission.js';
import { isLocalOrigin, originOf } from '../../../src/core/browser-agent/origin.js';
import { redact } from '../../../src/core/browser-agent/redact.js';
import { RingBuffer, clip } from '../../../src/core/browser-agent/ring.js';

const READS: BrowserCommand[] = ['console', 'network', 'dom', 'shot'];
const CONTROLS: BrowserCommand[] = ['navigate', 'click', 'type', 'eval'];

describe('permission matrix', () => {
  test('the command set is closed', () => {
    expect([...BROWSER_COMMANDS].sort()).toEqual([...READS, ...CONTROLS, 'list' as BrowserCommand].sort());
  });

  test('list never needs a level and never asks', () => {
    for (const level of ['off', 'read', 'control'] as AccessLevel[]) expect(decide('list', level, false)).toEqual({ ok: true, confirm: false });
  });

  test('off refuses every command that touches a page', () => {
    for (const c of [...READS, ...CONTROLS]) expect(decide(c, 'off', true)).toMatchObject({ ok: false, code: 'BROWSER_PANE_OFF' });
  });

  test('read allows reads on any origin and refuses control', () => {
    for (const c of READS) expect(decide(c, 'read', false)).toEqual({ ok: true, confirm: false });
    for (const c of CONTROLS) expect(decide(c, 'read', true)).toMatchObject({ ok: false, code: 'BROWSER_PANE_OFF' });
  });

  test('control: navigate/click/type run unasked on a local origin, ask elsewhere', () => {
    for (const c of ['navigate', 'click', 'type'] as BrowserCommand[]) {
      expect(decide(c, 'control', true)).toEqual({ ok: true, confirm: false });
      expect(decide(c, 'control', false)).toEqual({ ok: true, confirm: true });
    }
  });

  test('eval asks on every origin, local included', () => {
    expect(decide('eval', 'control', true)).toEqual({ ok: true, confirm: true });
    expect(decide('eval', 'control', false)).toEqual({ ok: true, confirm: true });
  });
});

describe('origin classification', () => {
  test.each(['http://localhost:3000/a', 'https://localhost', 'http://127.0.0.1:8080', 'http://[::1]:5173/x', 'HTTP://LOCALHOST:1'])('%s is local', (u) => {
    expect(isLocalOrigin(u)).toBe(true);
  });

  test.each([
    'http://localhost.evil.com', 'http://127.0.0.1.evil.com', 'http://evil.com/localhost', 'http://localhost@evil.com',
    'http://127.0.0.1@evil.com', 'http://evil.com#@localhost', 'http://localhost.:80', 'http://127.0.0.2', 'http://0.0.0.0',
    'about:blank', 'file:///etc/passwd', 'ftp://localhost', 'javascript:alert(1)', '', 'not a url', 'http://[::2]',
  ])('%s is not local', (u) => {
    expect(isLocalOrigin(u)).toBe(false);
  });

  test('originOf gives the origin, or null when there is none', () => {
    expect(originOf('https://example.com/a?b#c')).toBe('https://example.com');
    expect(originOf('about:blank')).toBeNull();
    expect(originOf('nope')).toBeNull();
  });
});

describe('redaction', () => {
  test('query parameters whose name looks secret lose their value', () => {
    expect(redact('http://x/api?token=abc123&page=2&apiKey=zz&Session_Id=9')).toBe('http://x/api?token=[redacted]&page=2&apiKey=[redacted]&Session_Id=[redacted]');
  });

  test('key=value and JSON-ish pairs in text', () => {
    expect(redact('login password=hunter2 ok')).toBe('login password=[redacted] ok');
    expect(redact('{"authorization": "Bearer abc", "n": 1}')).toBe('{"authorization": "[redacted]", "n": 1}');
    expect(redact("{'secret': 'x'}")).toBe("{'secret': '[redacted]'}");
    expect(redact('client_secret: s3cr3t next')).toBe('client_secret: [redacted] next');
  });

  test('ordinary text is left alone', () => {
    for (const s of ['Loading module app.js from /src', 'The key is under the mat', 'status of 404 (Not Found)', 'a=1&b=2', 'http://x/y?page=3']) expect(redact(s)).toBe(s);
  });

  test('is idempotent', () => {
    const once = redact('?token=abc&x=1');
    expect(redact(once)).toBe(once);
  });
});

describe('ring buffer and clip', () => {
  test('keeps the newest N and drops the oldest', () => {
    const r = new RingBuffer<number>(3);
    for (let i = 1; i <= 5; i++) r.push(i);
    expect(r.toArray()).toEqual([3, 4, 5]);
    expect(r.size).toBe(3);
  });

  test('clear empties it and it keeps working', () => {
    const r = new RingBuffer<string>(2);
    r.push('a');
    r.clear();
    expect(r.toArray()).toEqual([]);
    r.push('b');
    expect(r.toArray()).toEqual(['b']);
  });

  test('clip cuts long text and marks it', () => {
    expect(clip('abc', 5)).toBe('abc');
    expect(clip('abcdef', 3)).toBe('abc…');
  });
});
