import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { createDaemon, type Daemon } from '../../src/daemon/server.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { DaemonClient } from '../../src/client/rpc-client.js';
import { makeGitFixture, type GitFixture } from '../helpers/git-fixture.js';

let fx: GitFixture;
let db: Database;
let daemon: Daemon;
let socketPath: string;
let cockpit: DaemonClient;
let cli: DaemonClient;
let workspaceId: string;

beforeEach(async () => {
  fx = await makeGitFixture();
  socketPath = join(fx.root, '.crossweave', 'daemon.sock');
  db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
  daemon = createDaemon({ socketPath, methods: buildMethods(db, fx.root) });
  await daemon.listen();
  cockpit = await DaemonClient.connect(socketPath);
  cli = await DaemonClient.connect(socketPath);
  workspaceId = (await cli.call<{ id: string }>('workspace.init', {})).id;
});

afterEach(async () => {
  cockpit.close();
  cli.close();
  await daemon.close();
  db.close();
  await fx.cleanup();
});

describe('bridge over the real socket', () => {
  it('a shell command reaches the registered cockpit and gets its answer', async () => {
    const seen: Array<{ id: string; kind: string; params: unknown }> = [];
    cockpit.onNotification((method, params) => {
      if (method !== 'bridge.request') return;
      const req = params as { id: string; kind: string; params: unknown };
      seen.push(req);
      void cockpit.call('bridge.respond', { id: req.id, ok: true, result: { pong: true, echoed: req.params } });
    });
    await cockpit.call('bridge.register', { workspaceId, kinds: ['pane.ping'] });

    const result = await cli.call('bridge.call', { workspaceId, kind: 'pane.ping', params: { n: 7 } });
    expect(result).toEqual({ pong: true, echoed: { n: 7 } });
    expect(seen).toHaveLength(1);
  });

  it('no cockpit: the caller gets a typed error carrying the code', async () => {
    await expect(cli.call('bridge.call', { workspaceId, kind: 'pane.ping' })).rejects.toMatchObject({ code: 'BRIDGE_NO_COCKPIT' });
  });

  it('a second client cannot take the slot, nor answer a request it was not sent', async () => {
    cockpit.onNotification((method, params) => {
      if (method !== 'bridge.request') return;
      // the real cockpit answers a moment later
      setTimeout(() => void cockpit.call('bridge.respond', { id: (params as { id: string }).id, ok: true, result: 'real' }), 50);
    });
    await cockpit.call('bridge.register', { workspaceId, kinds: ['pane.ping'] });
    await expect(cli.call('bridge.register', { workspaceId, kinds: ['pane.ping'] })).rejects.toMatchObject({ code: 'BRIDGE_ALREADY_REGISTERED' });

    const intruder = await DaemonClient.connect(socketPath);
    let forged = false;
    intruder.onNotification(() => { forged = true; });
    const pending = cli.call('bridge.call', { workspaceId, kind: 'pane.ping' });
    // guess at an id: it is not the intruder's request, so the answer is ignored
    await intruder.call('bridge.respond', { id: 'br_GUESS', ok: true, result: 'forged' });
    expect(await pending).toBe('real');
    expect(forged).toBe(false);
    intruder.close();
  });

  it('the cockpit disconnecting fails a waiting call with BRIDGE_DETACHED', async () => {
    await cockpit.call('bridge.register', { workspaceId, kinds: ['pane.ping'] });
    const waiting = cli.call('bridge.call', { workspaceId, kind: 'pane.ping', timeoutMs: 30_000 });
    await new Promise((r) => setTimeout(r, 100));
    cockpit.close();
    await expect(waiting).rejects.toMatchObject({ code: 'BRIDGE_DETACHED' });
  });
});
