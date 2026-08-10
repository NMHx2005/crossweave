import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { connect, type Socket } from 'node:net';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { createDaemon, type Daemon } from '../../src/daemon/server.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { DaemonClient } from '../../src/client/rpc-client.js';
import { ClaudePtyAdapter } from '../../src/adapters/claude-pty.js';
import { CrossweaveError } from '../../src/core/errors.js';
import type { AgentAdapter } from '../../src/adapters/types.js';
import { mcpSocketPath } from '../../src/mcp/protocol.js';
import { makeGitFixture, commitFile, type GitFixture } from '../helpers/git-fixture.js';

/** Never spawns the real `claude` binary — see tests/daemon/runtime.test.ts's identical helper. */
function echoFactory(kind: string): AgentAdapter {
  if (kind !== 'claude') throw new CrossweaveError('UNKNOWN_AGENT', `Unsupported: ${kind}`);
  return new ClaudePtyAdapter('sh', ['-c', 'while IFS= read -r l; do eval "echo echo:$l"; done']);
}

let fx: GitFixture;
let db: Database;
let daemon: Daemon | undefined;
let client: DaemonClient | undefined;
let socketPath: string;

async function callMcp(mcpSocketPath: string, method: string, params: Record<string, unknown>, id = 1): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock: Socket = connect(mcpSocketPath);
    let buffer = '';
    sock.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) return;
      const line = buffer.slice(0, newlineIndex);
      sock.end();
      try {
        resolve(JSON.parse(line));
      } catch (err) {
        reject(err);
      }
    });
    sock.on('error', reject);
    sock.on('connect', () => {
      sock.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  });
}

/** Accepts an async predicate — several conditions here only settle asynchronously. */
async function waitFor(predicate: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('waitFor timed out');
}

/** True once nothing is listening at `path` AND the socket file itself is gone. */
async function isSocketGone(path: string): Promise<boolean> {
  if (existsSync(path)) return false;
  return new Promise((resolve) => {
    const sock = connect(path);
    sock.once('connect', () => {
      sock.destroy();
      resolve(false);
    });
    sock.once('error', () => resolve(true));
  });
}

beforeEach(async () => {
  fx = await makeGitFixture();
  socketPath = join(fx.root, '.crossweave', 'daemon.sock');
  db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
  daemon = createDaemon({ socketPath, methods: buildMethods(db, fx.root, echoFactory) });
  await daemon.listen();
  client = await DaemonClient.connect(socketPath);
});

afterEach(async () => {
  client?.close();
  await daemon?.close();
  db.close();
  await fx.cleanup();
});

describe('MCP server end-to-end', () => {
  it('two sessions exchange a message through their real MCP sockets', async () => {
    if (client === undefined) throw new Error('expected a client');
    const workspace = await client.call<{ id: string }>('workspace.init', {});
    const a = await client.call<{ id: string; name: string }>('session.new', {
      workspaceId: workspace.id, name: 'a', agent: 'claude', worktree: false,
    });
    const b = await client.call<{ id: string; name: string }>('session.new', {
      workspaceId: workspace.id, name: 'b', agent: 'claude', worktree: false,
    });
    await client.call('session.start', { workspaceId: workspace.id, idOrName: 'a', env: {} });
    await client.call('session.start', { workspaceId: workspace.id, idOrName: 'b', env: {} });

    const startedA = await client.call<{ mcpSocketPath: string }>('session.mcpInfo', {
      workspaceId: workspace.id, idOrName: 'a',
    });
    const startedB = await client.call<{ mcpSocketPath: string }>('session.mcpInfo', {
      workspaceId: workspace.id, idOrName: 'b',
    });

    await callMcp(startedA.mcpSocketPath, 'tools/call', { name: 'cw_send', arguments: { toSession: 'b', body: 'hi from a' } });

    const inboxResponse = (await callMcp(startedB.mcpSocketPath, 'tools/call', { name: 'cw_inbox', arguments: {} })) as {
      result: { content: { text: string }[] };
    };
    const messages = JSON.parse(inboxResponse.result.content[0]?.text ?? '[]') as { body: string }[];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toBe('hi from a');
  }, 30_000);

  it('a second cw_inbox over the real socket does not redeliver an already-read message', async () => {
    if (client === undefined) throw new Error('expected a client');
    const workspace = await client.call<{ id: string }>('workspace.init', {});
    await client.call('session.new', { workspaceId: workspace.id, name: 'a', agent: 'claude', worktree: false });
    await client.call('session.new', { workspaceId: workspace.id, name: 'b', agent: 'claude', worktree: false });
    await client.call('session.start', { workspaceId: workspace.id, idOrName: 'a', env: {} });
    await client.call('session.start', { workspaceId: workspace.id, idOrName: 'b', env: {} });
    const infoFor = async (name: string) =>
      client!.call<{ mcpSocketPath: string }>('session.mcpInfo', { workspaceId: workspace.id, idOrName: name });
    const [a, b] = await Promise.all([infoFor('a'), infoFor('b')]);
    if (!a || !b) throw new Error('expected mcp info for both');

    await callMcp(a.mcpSocketPath, 'tools/call', {
      name: 'cw_handoff', arguments: { toSession: 'b', body: 'take over this work' },
    });

    const poll = async (): Promise<unknown[]> => {
      const response = (await callMcp(b.mcpSocketPath, 'tools/call', { name: 'cw_inbox', arguments: {} })) as {
        result: { content: { text: string }[] };
      };
      return JSON.parse(response.result.content[0]?.text ?? '[]') as unknown[];
    };

    expect(await poll()).toHaveLength(1);
    expect(await poll()).toHaveLength(0);
    expect(await poll()).toHaveLength(0);
  }, 30_000);

  it('a broadcast reaches multiple sessions but not the sender', async () => {
    if (client === undefined) throw new Error('expected a client');
    const workspace = await client.call<{ id: string }>('workspace.init', {});
    await client.call('session.new', { workspaceId: workspace.id, name: 'a', agent: 'claude', worktree: false });
    await client.call('session.new', { workspaceId: workspace.id, name: 'b', agent: 'claude', worktree: false });
    await client.call('session.new', { workspaceId: workspace.id, name: 'c', agent: 'claude', worktree: false });
    for (const name of ['a', 'b', 'c']) {
      await client.call('session.start', { workspaceId: workspace.id, idOrName: name, env: {} });
    }

    const infoFor = async (name: string) =>
      client!.call<{ mcpSocketPath: string }>('session.mcpInfo', { workspaceId: workspace.id, idOrName: name });
    const [a, b, c] = await Promise.all([infoFor('a'), infoFor('b'), infoFor('c')]);
    if (!a || !b || !c) throw new Error('expected mcp info for all three');

    await callMcp(a.mcpSocketPath, 'tools/call', { name: 'cw_broadcast', arguments: { body: 'build is red' } });

    for (const info of [b, c]) {
      const response = (await callMcp(info.mcpSocketPath, 'tools/call', { name: 'cw_inbox', arguments: {} })) as {
        result: { content: { text: string }[] };
      };
      const messages = JSON.parse(response.result.content[0]?.text ?? '[]') as unknown[];
      expect(messages).toHaveLength(1);
    }
    const aInbox = (await callMcp(a.mcpSocketPath, 'tools/call', { name: 'cw_inbox', arguments: {} })) as {
      result: { content: { text: string }[] };
    };
    expect(JSON.parse(aInbox.result.content[0]?.text ?? '[]')).toHaveLength(0);
  }, 30_000);
});

describe('MCP server lifecycle (regression coverage for Task 8 wiring)', () => {
  it('session.stop closes the session\'s MCP server: its socket becomes unreachable', async () => {
    if (client === undefined) throw new Error('expected a client');
    const workspace = await client.call<{ id: string }>('workspace.init', {});
    await client.call('session.new', { workspaceId: workspace.id, name: 'a', agent: 'claude', worktree: false });
    await client.call('session.start', { workspaceId: workspace.id, idOrName: 'a', env: {} });
    const info = await client.call<{ mcpSocketPath: string }>('session.mcpInfo', {
      workspaceId: workspace.id, idOrName: 'a',
    });
    expect(await isSocketGone(info.mcpSocketPath)).toBe(false);

    await client.call('session.stop', { workspaceId: workspace.id, idOrName: 'a' });

    expect(await isSocketGone(info.mcpSocketPath)).toBe(true);
    await expect(
      client.call('session.mcpInfo', { workspaceId: workspace.id, idOrName: 'a' }),
    ).rejects.toMatchObject({ code: 'MCP_SERVER_NOT_RUNNING' });
  }, 30_000);

  it('the MCP server closes when the agent process exits on its own, not through session.stop', async () => {
    if (client === undefined) throw new Error('expected a client');
    const workspace = await client.call<{ id: string }>('workspace.init', {});
    await client.call('session.new', { workspaceId: workspace.id, name: 'a', agent: 'claude', worktree: false });
    const started = await client.call<{ pid: number | null }>('session.start', {
      workspaceId: workspace.id, idOrName: 'a', env: {},
    });
    const info = await client.call<{ mcpSocketPath: string }>('session.mcpInfo', {
      workspaceId: workspace.id, idOrName: 'a',
    });
    expect(await isSocketGone(info.mcpSocketPath)).toBe(false);
    if (started.pid === null) throw new Error('expected a pid');

    // Kills the underlying pty process directly — never goes through session.stop
    // or runtime.stop(), so the ONLY thing that can close the MCP server here is
    // the runtime's own exit callback wired in Task 8.
    process.kill(started.pid, 'SIGKILL');

    await waitFor(() => isSocketGone(info.mcpSocketPath));
  }, 30_000);

  it('a resume racing a stop leaves a reachable server that is still tracked', async () => {
    if (client === undefined) throw new Error('expected a client');
    const workspace = await client.call<{ id: string }>('workspace.init', {});
    await client.call('session.new', { workspaceId: workspace.id, name: 'a', agent: 'claude', worktree: false });
    await client.call('session.start', { workspaceId: workspace.id, idOrName: 'a', env: {} });

    // Deliberately not awaited: the daemon dispatches socket messages unserialized,
    // so a resume can land while a stop for the same session is still in flight. The
    // stop must retire ITS server, never the one the resume just installed, and the
    // resumed server must stay in the map so a later stop can still close it.
    const stopping = client.call('session.stop', { workspaceId: workspace.id, idOrName: 'a' });
    await waitFor(async () => {
      const rows = await client!.call<{ name: string; status: string }[]>('session.list', {
        workspaceId: workspace.id,
      });
      return rows.find((r) => r.name === 'a')?.status !== 'running';
    });
    await client.call('session.resume', { workspaceId: workspace.id, idOrName: 'a', env: {} });
    await stopping;

    const info = await client.call<{ mcpSocketPath: string }>('session.mcpInfo', {
      workspaceId: workspace.id, idOrName: 'a',
    });
    expect(await isSocketGone(info.mcpSocketPath)).toBe(false);

    await client.call('session.stop', { workspaceId: workspace.id, idOrName: 'a' });
    expect(await isSocketGone(info.mcpSocketPath)).toBe(true);
  }, 30_000);

  it('daemon.shutdown closes every still-tracked MCP server before exiting', async () => {
    if (client === undefined) throw new Error('expected a client');
    const workspace = await client.call<{ id: string }>('workspace.init', {});
    await client.call('session.new', { workspaceId: workspace.id, name: 'a', agent: 'claude', worktree: false });
    await client.call('session.new', { workspaceId: workspace.id, name: 'b', agent: 'claude', worktree: false });
    await client.call('session.start', { workspaceId: workspace.id, idOrName: 'a', env: {} });
    await client.call('session.start', { workspaceId: workspace.id, idOrName: 'b', env: {} });
    const infoFor = async (name: string) =>
      client!.call<{ mcpSocketPath: string }>('session.mcpInfo', { workspaceId: workspace.id, idOrName: name });
    const [a, b] = await Promise.all([infoFor('a'), infoFor('b')]);

    // Stub process.exit so daemon.shutdown's real exit timer doesn't tear down the
    // test runner — it's a top-level `setTimeout(() => process.exit(0), 10)`, which
    // fires shortly AFTER the RPC response, so it must be intercepted rather than
    // just not awaited.
    const originalExit = process.exit;
    const exitCalls: Array<number | undefined> = [];
    process.exit = ((code?: number): never => {
      exitCalls.push(code);
      return undefined as never;
    }) as typeof process.exit;
    try {
      await client.call('daemon.shutdown');
      // Give the stubbed-out exit timer room to fire before restoring the real one.
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      process.exit = originalExit;
    }
    expect(exitCalls).toEqual([0]);

    expect(await isSocketGone(a.mcpSocketPath)).toBe(true);
    expect(await isSocketGone(b.mcpSocketPath)).toBe(true);
  }, 30_000);

  it('blame is reachable over the daemon RPC and attributes a commit to its session', async () => {
    if (client === undefined) throw new Error('expected a client');
    const workspace = await client.call<{ id: string }>('workspace.init', {});
    const session = await client.call<{ id: string; name: string; worktreePath: string | null }>('session.new', {
      workspaceId: workspace.id, name: 'a', agent: 'claude', worktree: true,
    });
    if (session.worktreePath === null) throw new Error('expected a worktree');
    await commitFile(session.worktreePath, 'auth.ts', 'export const x = 1;\n', 'add auth.ts');

    const result = await client.call<{ sessionId: string; sessionName: string } | null>('blame', {
      workspaceId: workspace.id, file: 'auth.ts', line: 1,
    });

    expect(result?.sessionId).toBe(session.id);
    expect(result?.sessionName).toBe('a');
  }, 30_000);

  it('a session whose MCP server fails to bind still starts successfully (best-effort, not fatal)', async () => {
    if (client === undefined) throw new Error('expected a client');
    const workspace = await client.call<{ id: string }>('workspace.init', {});
    const session = await client.call<{ id: string }>('session.new', {
      workspaceId: workspace.id, name: 'a', agent: 'claude', worktree: false,
    });
    const collidingPath = mcpSocketPath(session.id);
    // Pre-create a directory at the socket path — `net.Server#listen` cannot bind
    // over it, and `unlinkSync` (files-only) inside createMcpServer can't clear it
    // either, exactly reproducing a real bind failure (see tests/mcp/server.test.ts).
    mkdirSync(collidingPath, { recursive: true });
    try {
      const started = await client.call<{ status: string }>('session.start', {
        workspaceId: workspace.id, idOrName: 'a', env: {},
      });
      expect(started.status).toBe('running');

      await expect(
        client.call('session.mcpInfo', { workspaceId: workspace.id, idOrName: 'a' }),
      ).rejects.toMatchObject({ code: 'MCP_SERVER_NOT_RUNNING' });
    } finally {
      rmSync(collidingPath, { recursive: true, force: true });
    }
  }, 30_000);
});
