import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { createDaemon, type Daemon } from '../../src/daemon/server.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { DaemonClient, connectOrStart } from '../../src/client/rpc-client.js';
import { makeGitFixture, type GitFixture } from '../helpers/git-fixture.js';

let fx: GitFixture;
let db: Database;
let daemon: Daemon | undefined;
let socketPath: string;

beforeEach(async () => {
  fx = await makeGitFixture();
  socketPath = join(fx.root, '.crossweave', 'daemon.sock');
  db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
});

afterEach(async () => {
  if (daemon) await daemon.close();
  daemon = undefined;
  db.close();
  await fx.cleanup();
});

describe('DaemonClient', () => {
  it('calls a method and gets the result', async () => {
    daemon = createDaemon({ socketPath, methods: buildMethods(db, fx.root) });
    await daemon.listen();
    const client = await DaemonClient.connect(socketPath);
    expect(await client.call('ping')).toEqual({ ok: true });
    client.close();
  });

  it('multiplexes concurrent calls onto one connection', async () => {
    daemon = createDaemon({ socketPath, methods: buildMethods(db, fx.root) });
    await daemon.listen();
    const client = await DaemonClient.connect(socketPath);
    const results = await Promise.all([
      client.call('ping'), client.call('ping'), client.call('ping'),
    ]);
    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    client.close();
  });

  it('rejects with the application error code from the daemon', async () => {
    daemon = createDaemon({ socketPath, methods: buildMethods(db, fx.root) });
    await daemon.listen();
    const client = await DaemonClient.connect(socketPath);
    await expect(client.call('workspace.info', { id: 'ghost' })).rejects.toMatchObject({
      code: 'WORKSPACE_NOT_FOUND',
    });
    client.close();
  });

  it('fails to connect when nothing is listening', async () => {
    await expect(DaemonClient.connect(socketPath)).rejects.toBeTruthy();
  });
});

describe('connectOrStart', () => {
  it('starts a daemon when none is running, then answers', async () => {
    const client = await connectOrStart(fx.root);
    expect(await client.call('ping')).toEqual({ ok: true });
    await client.call('daemon.shutdown').catch(() => undefined);
    client.close();
  }, 30_000);
});
