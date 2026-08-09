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

/** Accepts an async predicate — several conditions here are only observable over RPC. */
async function waitFor(predicate: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
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
    await client.call('session.stop', { workspaceId, idOrName: 'bye' });

    // Wait on the condition itself. The runtime's exit handler is asynchronous, so
    // anything that does not observe the actual row is testing nothing.
    type Row = { name: string; status: string; pid: number | null };
    let row: Row | undefined;
    await waitFor(async () => {
      const rows = await client.call<Row[]>('session.list', { workspaceId });
      row = rows.find((r) => r.name === 'bye');
      return row !== undefined && row.pid === null && row.status !== 'running';
    });

    expect(row?.status).toBe('idle');
    expect(row?.pid).toBeNull();
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

  // Regression: kill() writes 'dead' synchronously right after SIGTERM, but the pty's
  // exit callback arrives later and used to overwrite it with 'idle'. A killed session
  // that reads back as idle is worse than useless — `cw session list` would lie.
  it('kill stops a running agent and the exit handler does not resurrect it', async () => {
    await client.call('session.new', { workspaceId, name: 'auth', agent: 'claude', worktree: true });
    await client.call('session.start', { workspaceId, idOrName: 'auth' });
    await client.call('session.kill', { workspaceId, idOrName: 'auth', removeWorktree: false });

    type Row = { name: string; status: string };
    const statusOf = async (): Promise<string | undefined> => {
      const rows = await client.call<Row[]>('session.list', { workspaceId });
      return rows.find((r) => r.name === 'auth')?.status;
    };

    expect(await statusOf()).toBe('dead');
    // Give the pty's async exit callback time to land, then confirm it did not win.
    await new Promise((r) => setTimeout(r, 300));
    expect(await statusOf()).toBe('dead');
  });
});
