import { describe, expect, test } from 'bun:test';
import { Capture, queryConsole, queryNetwork } from '../../../src/core/browser-agent/capture.js';

function make(): { cap: Capture; tick: (ms: number) => void } {
  let now = 1000;
  return { cap: new Capture(() => now), tick: (ms) => { now += ms; } };
}

describe('console capture', () => {
  test('a console call becomes an entry with joined text, level and source', () => {
    const { cap } = make();
    cap.event('Runtime.consoleAPICalled', {
      type: 'warning', args: [{ type: 'string', value: 'low disk' }, { type: 'number', value: 3 }, { type: 'object', description: 'Object' }],
      stackTrace: { callFrames: [{ url: 'http://localhost/app.js', lineNumber: 41 }] },
    });
    expect(cap.console()).toEqual([{ t: 1000, level: 'warn', text: 'low disk 3 Object', url: 'http://localhost/app.js', line: 42 }]);
  });

  test('exceptions and log entries are errors too', () => {
    const { cap } = make();
    cap.event('Runtime.exceptionThrown', { exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: x is not a function' }, url: 'u.js', lineNumber: 0 } });
    cap.event('Log.entryAdded', { entry: { level: 'error', text: 'Failed to load resource', url: 'http://x/y.png' } });
    expect(cap.console().map((e) => [e.level, e.text])).toEqual([['error', 'TypeError: x is not a function'], ['error', 'Failed to load resource']]);
  });

  test('text is redacted and cut at 2 KB', () => {
    const { cap } = make();
    cap.event('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'GET /a?token=abc' }] });
    cap.event('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'x'.repeat(5000) }] });
    const [a, b] = cap.console();
    expect(a?.text).toBe('GET /a?token=[redacted]');
    expect(b?.text.length).toBe(2049);
  });

  test('keeps the last 500', () => {
    const { cap } = make();
    for (let i = 0; i < 600; i++) cap.event('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: `m${i}` }] });
    const all = cap.console();
    expect(all).toHaveLength(500);
    expect(all[0]?.text).toBe('m100');
  });

  test('malformed events are ignored, never thrown', () => {
    const { cap } = make();
    cap.event('Runtime.consoleAPICalled', null);
    cap.event('Runtime.consoleAPICalled', { type: 5, args: 'no' });
    cap.event('Something.else', {});
    expect(cap.console()).toEqual([]);
  });
});

describe('network capture', () => {
  test('one request: method, redacted url, status, type, duration and size', () => {
    const { cap } = make();
    cap.event('Network.requestWillBeSent', { requestId: '1', timestamp: 10, type: 'Fetch', request: { url: 'http://x/api?token=s&p=1', method: 'POST' } });
    cap.event('Network.responseReceived', { requestId: '1', type: 'Fetch', response: { status: 201 } });
    cap.event('Network.loadingFinished', { requestId: '1', timestamp: 10.25, encodedDataLength: 512 });
    expect(cap.network()).toEqual([{ t: 1000, method: 'POST', url: 'http://x/api?token=[redacted]&p=1', status: 201, type: 'Fetch', ms: 250, bytes: 512, failed: false }]);
  });

  test('a failed load carries the error', () => {
    const { cap } = make();
    cap.event('Network.requestWillBeSent', { requestId: '2', timestamp: 1, request: { url: 'http://x/a', method: 'GET' } });
    cap.event('Network.loadingFailed', { requestId: '2', timestamp: 1.1, errorText: 'net::ERR_CONNECTION_REFUSED' });
    expect(cap.network()[0]).toMatchObject({ failed: true, error: 'net::ERR_CONNECTION_REFUSED', status: 0 });
  });

  test('a redirect closes the first hop and starts the next', () => {
    const { cap } = make();
    cap.event('Network.requestWillBeSent', { requestId: '3', timestamp: 1, request: { url: 'http://x/a', method: 'GET' } });
    cap.event('Network.requestWillBeSent', { requestId: '3', timestamp: 1.1, request: { url: 'http://x/b', method: 'GET' }, redirectResponse: { status: 302 } });
    expect(cap.network().map((n) => [n.url, n.status])).toEqual([['http://x/a', 302], ['http://x/b', 0]]);
  });

  test('keeps the last 300; no headers or bodies are ever kept', () => {
    const { cap } = make();
    for (let i = 0; i < 350; i++) cap.event('Network.requestWillBeSent', { requestId: String(i), timestamp: i, request: { url: `http://x/${i}`, method: 'GET', headers: { Authorization: 'secret' }, postData: 'body' } });
    const all = cap.network();
    expect(all).toHaveLength(300);
    expect(JSON.stringify(all)).not.toMatch(/secret|body|headers/i);
  });

  test('events for a request never seen are ignored', () => {
    const { cap } = make();
    cap.event('Network.responseReceived', { requestId: 'ghost', response: { status: 200 } });
    cap.event('Network.loadingFinished', { requestId: 'ghost', timestamp: 1, encodedDataLength: 1 });
    expect(cap.network()).toEqual([]);
  });
});

describe('clearing', () => {
  const nav = (url: string, parentId?: string) => ({ frame: { url, ...(parentId === undefined ? {} : { parentId }) } });

  test('a top-level navigation to a different origin clears both buffers', () => {
    const { cap } = make();
    cap.event('Page.frameNavigated', nav('http://localhost:3000/'));
    cap.event('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'old' }] });
    cap.event('Network.requestWillBeSent', { requestId: '1', timestamp: 1, request: { url: 'http://localhost:3000/x', method: 'GET' } });
    cap.event('Page.frameNavigated', nav('https://example.com/'));
    expect(cap.console()).toEqual([]);
    expect(cap.network()).toEqual([]);
  });

  test('same origin and sub-frames keep what was captured', () => {
    const { cap } = make();
    cap.event('Page.frameNavigated', nav('http://localhost:3000/'));
    cap.event('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'keep' }] });
    cap.event('Page.frameNavigated', nav('http://localhost:3000/other'));
    cap.event('Page.frameNavigated', nav('https://ads.example.com/', 'frame-1'));
    expect(cap.console()).toHaveLength(1);
  });

  test('clear() empties everything and forgets the origin', () => {
    const { cap } = make();
    cap.event('Page.frameNavigated', nav('http://localhost:3000/'));
    cap.event('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'x' }] });
    cap.clear();
    expect(cap.console()).toEqual([]);
    cap.event('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'y' }] });
    expect(cap.console()).toHaveLength(1);
  });
});

describe('queries', () => {
  const entries = [
    { t: 1, level: 'info' as const, text: 'a' }, { t: 2, level: 'warn' as const, text: 'b' },
    { t: 3, level: 'error' as const, text: 'c' }, { t: 4, level: 'error' as const, text: 'd' },
  ];

  test('console: level, since and a limit that keeps the newest, every row marked untrusted', () => {
    expect(queryConsole(entries, { level: 'error' }).map((e) => e.text)).toEqual(['c', 'd']);
    expect(queryConsole(entries, { since: 3 }).map((e) => e.text)).toEqual(['c', 'd']);
    expect(queryConsole(entries, { level: 'all', limit: 2 }).map((e) => e.text)).toEqual(['c', 'd']);
    expect(queryConsole(entries, {}).every((e) => e.untrusted === true)).toBe(true);
  });

  test('console: the default limit is 50 and an absurd one is bounded', () => {
    const many = Array.from({ length: 700 }, (_, i) => ({ t: i, level: 'info' as const, text: String(i) }));
    expect(queryConsole(many, {})).toHaveLength(50);
    expect(queryConsole(many, { limit: 99999 })).toHaveLength(500);
  });

  test('network: failed only, since, untrusted', () => {
    const rows = [
      { t: 1, method: 'GET', url: 'a', status: 200, type: 'Fetch', ms: 1, bytes: 1, failed: false },
      { t: 2, method: 'GET', url: 'b', status: 0, type: 'Fetch', ms: 1, bytes: 0, failed: true, error: 'x' },
    ];
    expect(queryNetwork(rows, { failed: true }).map((r) => r.url)).toEqual(['b']);
    expect(queryNetwork(rows, { since: 2 }).map((r) => r.url)).toEqual(['b']);
    expect(queryNetwork(rows, {}).every((r) => r.untrusted === true)).toBe(true);
  });
});
