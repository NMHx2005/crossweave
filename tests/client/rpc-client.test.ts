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
    expect(await client.call<{ ok: boolean }>('ping')).toEqual({ ok: true });
    client.close();
  });

  it('multiplexes concurrent calls onto one connection', async () => {
    daemon = createDaemon({ socketPath, methods: buildMethods(db, fx.root) });
    await daemon.listen();
    const client = await DaemonClient.connect(socketPath);
    const results = await Promise.all([
      client.call<{ ok: boolean }>('ping'), client.call<{ ok: boolean }>('ping'), client.call<{ ok: boolean }>('ping'),
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

  // Regression: `connect` strips its temporary 'error' listener once connected, and
  // the constructor only registered 'data' and 'close'. Node THROWS an 'error' event
  // with no listener, so a daemon dying mid-session killed the CLI with an uncaught
  // exception instead of rejecting the call.
  // Regression: onClose only pushed onto the handler list. `cw session attach`
  // registers it after two awaited RPCs, so a daemon dying in that window left the
  // CLI hung in raw mode — the very symptom onClose exists to prevent.
  it('onClose fires immediately when registered after the connection is already gone', async () => {
    daemon = createDaemon({ socketPath, methods: buildMethods(db, fx.root) });
    await daemon.listen();
    const client = await DaemonClient.connect(socketPath);
    await daemon.close();
    daemon = undefined;
    while (client.isConnected) await new Promise((r) => setTimeout(r, 5));

    let fired = false;
    client.onClose(() => { fired = true; });
    expect(fired).toBe(true);
    client.close();
  });

  // Regression: `connect` strips its temporary 'error' listener once connected, and
  // without re-registering one a socket error is THROWN by Node as an uncaught
  // exception — a raw stack trace with internal $bunfs paths, killing the CLI instead
  // of failing the call. Removing that listener left the whole suite green.
  it('a socket error does not escape as an uncaught exception', async () => {
    daemon = createDaemon({ socketPath, methods: buildMethods(db, fx.root) });
    await daemon.listen();
    const client = await DaemonClient.connect(socketPath);

    let uncaught: unknown;
    const onUncaught = (err: unknown): void => { uncaught = err; };
    process.once('uncaughtException', onUncaught);
    try {
      await daemon.close();
      daemon = undefined;
      while (client.isConnected) await new Promise((r) => setTimeout(r, 5));
      // Writing into the dead socket is what raises the error event.
      await expect(client.call('ping')).rejects.toMatchObject({ code: 'DAEMON_GONE' });
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.removeListener('uncaughtException', onUncaught);
    }
    expect(uncaught).toBeUndefined();
    client.close();
  });

  it('one throwing close handler does not starve the others', async () => {
    daemon = createDaemon({ socketPath, methods: buildMethods(db, fx.root) });
    await daemon.listen();
    const client = await DaemonClient.connect(socketPath);

    const seen: string[] = [];
    client.onClose(() => { seen.push('first'); });
    client.onClose(() => { throw new Error('bad close handler'); });
    client.onClose(() => { seen.push('third'); });

    await daemon.close();
    daemon = undefined;
    while (client.isConnected) await new Promise((r) => setTimeout(r, 5));

    expect(seen).toEqual(['first', 'third']);
    client.close();
  });

  it('rejects with DAEMON_GONE instead of crashing or hanging when the daemon goes away', async () => {
    daemon = createDaemon({ socketPath, methods: buildMethods(db, fx.root) });
    await daemon.listen();
    const client = await DaemonClient.connect(socketPath);
    expect(await client.call<{ ok: boolean }>('ping')).toEqual({ ok: true });

    await daemon.close();
    daemon = undefined;

    // Wait for the client to actually observe the disconnect rather than racing the
    // teardown. This loop can only exit once the state under test is real, and the
    // per-test timeout is what catches it if the client never notices — which is
    // precisely the regression: the earlier version hung here forever.
    while (client.isConnected) await new Promise((r) => setTimeout(r, 5));

    await expect(client.call('ping')).rejects.toMatchObject({ code: 'DAEMON_GONE' });
    client.close();
  });
});

describe('connectOrStart', () => {
  it('starts a daemon when none is running, then answers', async () => {
    const client = await connectOrStart(fx.root);
    expect(await client.call<{ ok: boolean }>('ping')).toEqual({ ok: true });
    await client.call('daemon.shutdown').catch(() => undefined);
    client.close();
  }, 30_000);
});
