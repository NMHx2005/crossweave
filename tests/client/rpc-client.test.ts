import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { createDaemon, type Daemon } from '../../src/daemon/server.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { DaemonClient, connectOrStart } from '../../src/client/rpc-client.js';
import type { ClientTransport } from '../../src/client/transport.js';
import { DAEMON_EXIT_ALREADY_RUNNING } from '../../src/core/exit-codes.js';
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
      // Reach the TRANSPORT directly (the client's only byte path since the seam
      // landed). Going through call() cannot raise a transport 'error' — its
      // isConnected pre-check refuses to write first — which is exactly why the
      // previous version of this test passed with the listener deleted.
      const transport = (client as unknown as { transport: ClientTransport }).transport;
      await daemon.close();
      daemon = undefined;
      transport.write('x'.repeat(1024 * 1024));
      transport.write('y\n');
      await new Promise((r) => setTimeout(r, 200));
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

  // A daemon that exits as it starts (a folder that is not a repository, a broken
  // install) used to be noticed only when the 10 s wait ran out.
  it('says at once when the daemon exits before listening', async () => {
    const started = Date.now();
    const err = await connectOrStart(fx.root, { command: 'sh', args: ['-c', 'exit 3'] }).catch((e: Error) => e) as Error & { code?: string };
    expect(err.code).toBe('DAEMON_START_FAILED');
    expect(err.message).toMatch(/stopped as it started/);
    expect(Date.now() - started).toBeLessThan(3000);
  }, 15_000);

  // Regression: with the daemon now exiting on a startup failure, a daemon that merely
  // lost the bind race to another must not be reported as a start failure — the winner
  // owns the socket and is exactly what the caller wanted.
  it('keeps waiting, then connects, when another daemon already owns the socket', async () => {
    const pending = connectOrStart(fx.root, {
      command: process.execPath,
      args: ['-e', `process.exit(${DAEMON_EXIT_ALREADY_RUNNING})`],
    });
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });

    await new Promise((r) => setTimeout(r, 400));
    expect(settled).toBe(false); // the already-running exit did not fail the start

    daemon = createDaemon({ socketPath, methods: buildMethods(db, fx.root) });
    await daemon.listen();

    const client = await pending;
    expect(await client.call<{ ok: boolean }>('ping')).toEqual({ ok: true });
    client.close();
  }, 30_000);

  // Without the log, a daemon that stopped (its socket removed or replaced) left only
  // rows reconciled to `idle`/`dead` — no reason anywhere.
  it('writes the daemon lifecycle log so a stop has a reason', async () => {
    const client = await connectOrStart(fx.root);
    expect(await client.call<{ ok: boolean }>('ping')).toEqual({ ok: true });
    await client.call('daemon.shutdown').catch(() => undefined);
    client.close();

    const logPath = join(fx.root, '.crossweave', 'daemon.log');
    const deadline = Date.now() + 3000;
    let text = '';
    while (Date.now() < deadline) {
      try { text = readFileSync(logPath, 'utf8'); } catch { text = ''; }
      if (text.includes('listening at')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(text).toContain('listening at');
  }, 30_000);
});
