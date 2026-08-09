import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
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

/** Echoes each stdin line back, so tests never need the real `claude` binary. */
function echoFactory(kind: string): AgentAdapter {
  if (kind !== 'claude') throw new CrossweaveError('UNKNOWN_AGENT', `Unsupported: ${kind}`);
  return new ClaudePtyAdapter('sh', ['-c', 'while IFS= read -r l; do echo "echo:$l"; done']);
}

let fx: GitFixture;
let db: Database;
let daemon: Daemon;
let client: DaemonClient;
let socketPath: string;
let workspaceId: string;

async function waitFor(predicate: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('waitFor timed out');
}

beforeEach(async () => {
  fx = await makeGitFixture();
  socketPath = join(fx.root, '.crossweave', 'daemon.sock');
  db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
  daemon = createDaemon({
    socketPath,
    methods: buildMethods(db, fx.root, echoFactory),
  });
  await daemon.listen();
  client = await DaemonClient.connect(socketPath);
  workspaceId = (await client.call<{ id: string }>('workspace.init', {})).id;
});

afterEach(async () => {
  client.close();
  await daemon.close();
  db.close();
  await fx.cleanup();
});

describe('session runtime', () => {
  it('starts an agent and marks the session running with a pid', async () => {
    await client.call('session.new', { workspaceId, name: 'auth', agent: 'claude', worktree: true });
    const started = await client.call<{ status: string; pid: number }>('session.start', {
      workspaceId, idOrName: 'auth',
    });
    expect(started.status).toBe('running');
    expect(started.pid).toBeGreaterThan(0);
  });

  it('streams agent output to a subscriber and accepts input', async () => {
    await client.call('session.new', { workspaceId, name: 'auth', agent: 'claude', worktree: true });
    await client.call('session.start', { workspaceId, idOrName: 'auth' });

    let seen = '';
    client.onNotification((method, params) => {
      if (method === 'session.data') seen += (params as { chunk: string }).chunk;
    });

    await client.call('session.attach', { workspaceId, idOrName: 'auth' });
    await client.call('session.input', { workspaceId, idOrName: 'auth', data: 'ping\n' });
    await waitFor(() => seen.includes('echo:ping'));
    expect(seen).toContain('echo:ping');
  });

  it('replays recent scrollback to a late subscriber', async () => {
    await client.call('session.new', { workspaceId, name: 'auth', agent: 'claude', worktree: true });
    await client.call('session.start', { workspaceId, idOrName: 'auth' });
    await client.call('session.attach', { workspaceId, idOrName: 'auth' });
    await client.call('session.input', { workspaceId, idOrName: 'auth', data: 'early\n' });

    let late = '';
    const second = await DaemonClient.connect(socketPath);
    second.onNotification((method, params) => {
      if (method === 'session.data') late += (params as { chunk: string }).chunk;
    });
    await new Promise((r) => setTimeout(r, 300));
    await second.call('session.attach', { workspaceId, idOrName: 'auth' });
    await waitFor(() => late.includes('echo:early'));
    expect(late).toContain('echo:early');
    second.close();
  });

  it('refuses to start an already running session', async () => {
    await client.call('session.new', { workspaceId, name: 'auth', agent: 'claude', worktree: true });
    await client.call('session.start', { workspaceId, idOrName: 'auth' });
    await expect(client.call('session.start', { workspaceId, idOrName: 'auth' })).rejects.toMatchObject(
      { code: 'SESSION_ALREADY_RUNNING' },
    );
  });

  it('refuses to attach to a session that is not running', async () => {
    await client.call('session.new', { workspaceId, name: 'auth', agent: 'claude', worktree: true });
    await expect(client.call('session.attach', { workspaceId, idOrName: 'auth' })).rejects.toMatchObject(
      { code: 'SESSION_NOT_RUNNING' },
    );
  });

  it('marks the session idle and clears the pid when the agent exits', async () => {
    await client.call('session.new', { workspaceId, name: 'bye', agent: 'claude', worktree: true });
    await client.call('session.start', { workspaceId, idOrName: 'bye' });
    await client.call('session.input', { workspaceId, idOrName: 'bye', data: '' });
    await client.call('session.stop', { workspaceId, idOrName: 'bye' });

    await waitFor(async () => true);
    const rows = await client.call<{ name: string; status: string; pid: number | null }[]>(
      'session.list', { workspaceId },
    );
    const row = rows.find((r) => r.name === 'bye')!;
    expect(['idle', 'dead']).toContain(row.status);
    expect(row.pid).toBeNull();
  });

  it('resume starts a stopped session again', async () => {
    await client.call('session.new', { workspaceId, name: 'auth', agent: 'claude', worktree: true });
    await client.call('session.start', { workspaceId, idOrName: 'auth' });
    await client.call('session.stop', { workspaceId, idOrName: 'auth' });
    const again = await client.call<{ status: string }>('session.resume', {
      workspaceId, idOrName: 'auth',
    });
    expect(again.status).toBe('running');
  });

  it('kill stops a running agent', async () => {
    await client.call('session.new', { workspaceId, name: 'auth', agent: 'claude', worktree: true });
    await client.call('session.start', { workspaceId, idOrName: 'auth' });
    await client.call('session.kill', { workspaceId, idOrName: 'auth', removeWorktree: false });
    const rows = await client.call<{ name: string; status: string }[]>('session.list', { workspaceId });
    expect(rows.find((r) => r.name === 'auth')!.status).toBe('dead');
  });
});
