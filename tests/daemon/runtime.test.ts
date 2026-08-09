import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { createDaemon, type Daemon, type MethodContext } from '../../src/daemon/server.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { SessionRuntime } from '../../src/daemon/runtime.js';
import { SessionManager } from '../../src/domain/session.js';
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
let sessions: SessionManager;

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
  sessions = new SessionManager(db, echoFactory);
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

describe('attach detach key', () => {
  // Regression, and the cheapest possible guard on the defect that actually shipped:
  // the literal control byte was lost in transcription, leaving ''. With the old
  // `includes` check that made the FIRST keystroke detach, so no input ever reached
  // the agent — the headline feature of this milestone was completely dead, and no
  // test noticed because the interactive path was explicitly waived.
  it('is Ctrl-] and exactly one character', async () => {
    const { DETACH_KEY } = await import('../../src/cli/commands/attach.js');
    expect(DETACH_KEY).toBe('\x1d');
    expect(DETACH_KEY).toHaveLength(1);
    expect(DETACH_KEY).not.toBe('');
  });
});

describe('SessionRuntime subscriber isolation', () => {
  // Task 7 isolated the ADAPTER's fan-out; SessionRuntime has its own loops and had
  // to be fixed separately. The exit path mattered most: a throw there skipped
  // `running.delete` and `onExit`, wedging the session at `running` with a stale pid
  // and making it permanently unstartable.
  function fakeContext(onNotify: (m: string) => void): MethodContext {
    return { notify: (m) => onNotify(m), onClose: () => undefined };
  }

  it('keeps delivering to other subscribers when one throws, and still cleans up', async () => {
    const exits: string[] = [];
    const runtime = new SessionRuntime((id) => exits.push(id));
    const row = await sessions.create({
      workspaceId, name: 'iso', agent: 'claude', worktree: true,
    });

    const seen: string[] = [];
    runtime.start(row, new ClaudePtyAdapter('sh', ['-c', 'echo hi; exit 0']));
    runtime.subscribe(row.id, row.name, fakeContext(() => seen.push('first')));
    runtime.subscribe(row.id, row.name, fakeContext(() => { throw new Error('bad'); }));
    runtime.subscribe(row.id, row.name, fakeContext(() => seen.push('third')));

    await waitFor(() => exits.includes(row.id));

    expect(seen).toContain('first');
    expect(seen).toContain('third');
    // The bookkeeping must have run despite the throw.
    expect(runtime.isRunning(row.id)).toBe(false);
  }, 15_000);
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

  // Regression: neither start nor resume checked the status, so a killed session
  // could be resumed straight back to running — which would have made `dead` and
  // `idle` the same thing and the kill meaningless.
  it('refuses to start or resume a killed session', async () => {
    await client.call('session.new', { workspaceId, name: 'gone', agent: 'claude', worktree: true });
    await client.call('session.start', { workspaceId, idOrName: 'gone' });
    await client.call('session.kill', { workspaceId, idOrName: 'gone', removeWorktree: false });

    await expect(
      client.call('session.resume', { workspaceId, idOrName: 'gone' }),
    ).rejects.toMatchObject({ code: 'SESSION_ENDED' });
    await expect(
      client.call('session.start', { workspaceId, idOrName: 'gone' }),
    ).rejects.toMatchObject({ code: 'SESSION_ENDED' });

    // Checked immediately, while the runtime may still report the pty as running —
    // that window used to return a stale `dead` row with no error.
    const rows = await client.call<{ name: string; status: string }[]>(
      'session.list', { workspaceId },
    );
    expect(rows.find((r) => r.name === 'gone')?.status).toBe('dead');
  });

  // Regression, and the reason this assertion is on the PID: a reviewer replaced
  // session.resume's body with `return row` — never restarting anything — and the
  // entire 133-test suite still passed, because the stale pre-exit row already said
  // "running". Asserting on status alone tested nothing.
  it('resume after stop starts a genuinely new process', async () => {
    await client.call('session.new', { workspaceId, name: 'again', agent: 'claude', worktree: true });
    const first = await client.call<{ pid: number }>('session.start', {
      workspaceId, idOrName: 'again',
    });
    await client.call('session.stop', { workspaceId, idOrName: 'again' });

    const second = await client.call<{ pid: number; status: string }>('session.resume', {
      workspaceId, idOrName: 'again',
    });
    expect(second.status).toBe('running');
    expect(second.pid).not.toBe(first.pid);
  });

  // Regression: stop returned as soon as SIGTERM was sent, so an agent that ignores
  // it was reported stopped while still alive — and kill then cleared the pid,
  // leaving a stranded process nothing could ever find again.
  //
  // Tested directly against SessionRuntime with a short grace period, and it waits
  // for the trap to be INSTALLED before signalling. An earlier version of this test
  // signalled immediately and the agent died from the raw SIGTERM before its trap
  // existed — so it passed in 0.14s without ever reaching the SIGKILL branch it
  // claimed to cover. Asserting on elapsed time is what keeps it honest.
  it('escalates to SIGKILL when the agent ignores SIGTERM', async () => {
    const runtime = new SessionRuntime(() => undefined);
    const row = await sessions.create({
      workspaceId, name: 'stubborn', agent: 'claude', worktree: true,
    });
    const pid = runtime.start(
      row,
      new ClaudePtyAdapter('sh', ['-c', 'trap "" TERM; echo TRAPPED; while true; do sleep 0.05; done']),
    );

    let out = '';
    runtime.subscribe(row.id, row.name, {
      notify: (_m, p) => { out += (p as { chunk?: string }).chunk ?? ''; },
      onClose: () => undefined,
    });
    await waitFor(() => out.includes('TRAPPED'));

    const startedAt = Date.now();
    await runtime.stop(row.id, 200);
    const elapsed = Date.now() - startedAt;

    expect(runtime.isRunning(row.id)).toBe(false);
    // Proof the escalation branch actually ran rather than the process dying on the
    // first signal: it cannot have returned before the grace period elapsed.
    expect(elapsed).toBeGreaterThanOrEqual(200);

    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  }, 15_000);

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
