import { describe, it, expect, afterEach } from 'bun:test';
import { connect } from 'node:net';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createMcpServer, type McpServerHandle } from '../../src/mcp/server.js';
import { mcpSocketPath, type McpTool } from '../../src/mcp/protocol.js';

describe('createMcpServer', () => {
  let handle: McpServerHandle | undefined;

  afterEach(async () => {
    if (handle !== undefined) {
      await handle.close();
      handle = undefined;
    }
  });

  it('a bind failure is caught and does not crash the process', async () => {
    const sessionId = `bind-fail-${Date.now()}`;
    const socketPath = mcpSocketPath(sessionId);
    // Pre-create a directory at the socket path: `unlinkSync` (files-only) can't
    // clear it, so `netServer.listen()` fails to bind — reproducing the reset
    // attempt's crash bug on a real bind failure, not just a code-reading claim.
    mkdirSync(socketPath, { recursive: true });
    try {
      // createMcpServer itself must return synchronously without throwing, and the
      // async bind failure must be handled by the 'error' listener, not crash the process.
      handle = createMcpServer(sessionId, []);
      expect(handle.socketPath).toBe(socketPath);
      // Give the async 'error' event a tick to fire; if it were unhandled, this
      // test process would have already been torn down by an uncaught exception.
      await new Promise((resolve) => setTimeout(resolve, 100));
      // Still alive to make this assertion — the crash-prevention property held.
      expect(true).toBe(true);
    } finally {
      rmSync(socketPath, { recursive: true, force: true });
    }
  });

  it('a stale close does not unlink a newer server sharing the same socket path', async () => {
    // The fast stop-then-resume race: a second server for the same session id is
    // created while the first one's close() is still in flight. Both act on a NAME.
    // Before the inode check in close(), the second server ended up `listening()`
    // true with its socket file deleted by the first's close — running, and
    // unreachable to every client.
    const sessionId = `stale-close-${process.pid}-${Date.now()}`;
    const first = createMcpServer(sessionId, []);
    expect(await first.ready()).toBe(true);

    const closingFirst = first.close();
    handle = createMcpServer(sessionId, []);
    expect(await handle.ready()).toBe(true);
    await closingFirst;

    expect(handle.listening()).toBe(true);
    expect(existsSync(handle.socketPath)).toBe(true);
    const connected = await new Promise<boolean>((resolve) => {
      const client = connect(handle!.socketPath);
      client.once('connect', () => {
        client.destroy();
        resolve(true);
      });
      client.once('error', () => resolve(false));
    });
    expect(connected).toBe(true);
  });

  it('close() resolves within a timeout even with an open client connection', async () => {
    const sessionId = `close-hang-${Date.now()}`;
    const echoTool: McpTool = {
      name: 'echo',
      description: 'Echoes its input',
      inputSchema: { type: 'object', properties: {} },
      handler: async (args) => ({ content: [{ type: 'text', text: String(args.text) }] }),
    };
    handle = createMcpServer(sessionId, [echoTool]);
    const socketPath = handle.socketPath;

    // Wait for the server to actually be listening before connecting.
    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const check = (): void => {
        if (existsSync(socketPath)) {
          resolve();
        } else if (Date.now() - start > 2000) {
          reject(new Error('server never bound'));
        } else {
          setTimeout(check, 10);
        }
      };
      check();
    });

    const client = connect(socketPath);
    client.on('error', () => {
      // A close-triggered ECONNRESET on the client side is expected and not a test failure.
    });
    await new Promise<void>((resolve, reject) => {
      client.once('connect', () => resolve());
      client.once('error', reject);
    });

    const closePromise = handle.close();
    const timeout = new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 2000));
    const result = await Promise.race([closePromise.then(() => 'closed' as const), timeout]);

    expect(result).toBe('closed');
    handle = undefined; // already closed
    client.destroy();
  });
});
