import { describe, it, expect, afterEach } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAEMON_EXIT_ALREADY_RUNNING } from '../../src/core/exit-codes.js';
import { createDaemon, type Daemon } from '../../src/daemon/server.js';
import { makeGitFixture, type GitFixture } from '../helpers/git-fixture.js';

const ENTRY = fileURLToPath(new URL('../../src/daemon/main.ts', import.meta.url));

/** Run the real daemon entry and resolve with its exit code (hangs if it never exits). */
function runDaemon(cwd: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY], { cwd, stdio: 'ignore' });
    child.on('exit', (code) => resolve(code));
  });
}

describe('daemon entry', () => {
  let daemon: Daemon | undefined;
  let fx: GitFixture | undefined;

  afterEach(async () => {
    if (daemon) await daemon.close();
    daemon = undefined;
    await fx?.cleanup();
    fx = undefined;
  });

  // Regression: main() had no `.catch`, so a startup failure fell through to the
  // module's `unhandledRejection` handler — which only logs — and the process lingered
  // forever. `connectOrStart` spawns a daemon on every failed connect, so they piled up
  // (hundreds were found on one machine). The test hangs on a process that never exits.
  it('exits instead of lingering when it cannot start', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cw-notgit-'));
    try {
      const code = await runDaemon(dir);
      expect(code).not.toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);

  // The bind-race loser is not a failure: the client that spawned it must keep waiting
  // for the daemon that actually owns the socket, so its exit code carries that meaning.
  it('exits with DAEMON_EXIT_ALREADY_RUNNING when another daemon owns the socket', async () => {
    fx = await makeGitFixture();
    const socketPath = join(fx.root, '.crossweave', 'daemon.sock');
    daemon = createDaemon({ socketPath, methods: {} });
    await daemon.listen();

    const code = await runDaemon(fx.root);
    expect(code).toBe(DAEMON_EXIT_ALREADY_RUNNING);
  }, 15_000);
});
