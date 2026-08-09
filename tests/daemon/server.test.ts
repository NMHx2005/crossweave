import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { createDaemon, type Daemon } from '../../src/daemon/server.js';
import { buildMethods } from '../../src/daemon/methods.js';
import { encodeFrame, createFrameDecoder, RPC_ERROR_CODES } from '../../src/daemon/rpc.js';
import { makeGitFixture, type GitFixture } from '../helpers/git-fixture.js';

let fx: GitFixture;
let db: Database;
let daemon: Daemon;
let socketPath: string;

function rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock: Socket = connect(socketPath, () => {
      sock.write(encodeFrame({ jsonrpc: '2.0', id: 1, method, params }));
    });
    const decode = createFrameDecoder((msg) => {
      const r = msg as { result?: unknown; error?: { code: number; message: string } };
      sock.end();
      if (r.error) reject(r.error);
      else resolve(r.result);
    });
    sock.on('data', decode);
    sock.on('error', reject);
  });
}

beforeEach(async () => {
  fx = await makeGitFixture();
  socketPath = join(fx.root, '.crossweave', 'daemon.sock');
  db = openDatabase(join(fx.root, '.crossweave', 'state.db'));
  daemon = createDaemon({ socketPath, methods: buildMethods(db, fx.root) });
  await daemon.listen();
});

afterEach(async () => {
  await daemon.close();
  db.close();
  await fx.cleanup();
});

describe('daemon server', () => {
  it('answers ping', async () => {
    expect(await rpc('ping')).toEqual({ ok: true });
  });

  it('returns METHOD_NOT_FOUND for an unknown method', async () => {
    await expect(rpc('nope')).rejects.toMatchObject({ code: RPC_ERROR_CODES.METHOD_NOT_FOUND });
  });

  it('maps a CrossweaveError to an application error carrying its code', async () => {
    await expect(rpc('workspace.info', { id: 'ghost' })).rejects.toMatchObject({
      code: RPC_ERROR_CODES.APPLICATION,
      data: { code: 'WORKSPACE_NOT_FOUND' },
    });
  });

  it('runs the workspace and session lifecycle end to end', async () => {
    const ws = (await rpc('workspace.init', {})) as { id: string; name: string };
    expect(ws.name).toBe(fx.root.split('/').pop()!);

    const s = (await rpc('session.new', {
      workspaceId: ws.id, name: 'auth', agent: 'claude', worktree: true,
    })) as { id: string; worktreePath: string; status: string };
    expect(s.status).toBe('idle');
    expect(existsSync(s.worktreePath)).toBe(true);

    const list = (await rpc('session.list', { workspaceId: ws.id })) as unknown[];
    expect(list).toHaveLength(1);

    const renamed = (await rpc('session.rename', {
      workspaceId: ws.id, idOrName: 'auth', newName: 'auth2',
    })) as { name: string };
    expect(renamed.name).toBe('auth2');

    await rpc('session.kill', { workspaceId: ws.id, idOrName: 'auth2', removeWorktree: true });
    expect(existsSync(s.worktreePath)).toBe(false);
  });

  it('creates the socket owner-only and the state directory 0700', async () => {
    const { statSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(socketPath)).mode & 0o777).toBe(0o700);
  });

  it('removes a stale socket file on listen', async () => {
    await daemon.close();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(socketPath, 'stale');
    daemon = createDaemon({ socketPath, methods: buildMethods(db, fx.root) });
    await daemon.listen();
    expect(await rpc('ping')).toEqual({ ok: true });
  });

  // Regression: unlinking unconditionally let a second daemon silently steal the
  // socket from a live one. The first kept running, holding agent ptys, while every
  // client reached the second — and neither process was told.
  it('refuses to steal the socket from a daemon that is still live', async () => {
    const second = createDaemon({ socketPath, methods: buildMethods(db, fx.root) });
    await expect(second.listen()).rejects.toMatchObject({ code: 'DAEMON_ALREADY_RUNNING' });
    // The original is untouched and still serving.
    expect(await rpc('ping')).toEqual({ ok: true });
    await second.close();
  });

  it('creates the state directory owner-only from openDatabase alone', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { statSync } = await import('node:fs');
    const dir = await mkdtemp(join(tmpdir(), 'cw-mode-'));
    try {
      const fresh = openDatabase(join(dir, '.crossweave', 'state.db'));
      expect(statSync(join(dir, '.crossweave')).mode & 0o777).toBe(0o700);
      fresh.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('unlinks the socket on close', async () => {
    await daemon.close();
    expect(existsSync(socketPath)).toBe(false);
    daemon = createDaemon({ socketPath, methods: buildMethods(db, fx.root) });
    await daemon.listen();
  });
});
