import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { createDaemon, type Daemon } from '../../src/daemon/server.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { DaemonClient } from '../../src/client/rpc-client.js';
import { ClaudePtyAdapter } from '../../src/adapters/claude-pty.js';
import { CrossweaveError } from '../../src/core/errors.js';
import type { AgentAdapter } from '../../src/adapters/types.js';
import { makeGitFixture, type GitFixture } from '../helpers/git-fixture.js';

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
