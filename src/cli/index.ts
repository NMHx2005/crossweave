#!/usr/bin/env bun
import { join } from 'node:path';
import { defineCommand, runMain } from 'citty';
import { crossweaveDir, findProjectRoot } from '../core/paths.js';
import { VERSION } from '../core/version.js';
import { DaemonClient } from '../client/rpc-client.js';
import { CrossweaveError } from '../core/errors.js';
import { initCommand, workspaceCommand, gcCommand } from './commands/workspace.js';
import { sessionCommand } from './commands/session.js';
import { blameCommand } from './commands/blame.js';
import { radarHookCommand } from './commands/radar-hook.js';
import { contractCommand } from './commands/contract.js';
import { convergeCommand } from './commands/converge.js';
import { landCommand } from './commands/land.js';
import { configCommand } from './commands/config.js';
import { fail } from './context.js';

const daemonCommand = defineCommand({
  meta: { name: 'daemon', description: 'Manage the crossweave daemon' },
  subCommands: {
    stop: defineCommand({
      meta: { name: 'stop', description: 'Stop the daemon for this repository' },
      async run() {
        try {
          // Deliberately connects rather than using withClient: connectOrStart would
          // spawn a daemon just to shut it down. Nothing listening means the daemon is
          // already stopped, which is the outcome asked for, so it exits 0.
          const projectRoot = findProjectRoot(process.cwd());
          const socketPath = join(crossweaveDir(projectRoot), 'daemon.sock');

          let client: DaemonClient;
          try {
            client = await DaemonClient.connect(socketPath);
          } catch {
            process.stdout.write('no daemon running\n');
            return;
          }

          await client.call('daemon.shutdown').catch(() => undefined);
          // The RPC acks before the daemon's own `process.exit(0)` timer fires, so
          // returning right after the ack races ahead of the process actually being
          // gone — a caller (or a test asserting no `cwd` survives) could observe
          // "daemon stopped" while it is still exiting. Wait for the socket to close,
          // which only happens once the daemon process has actually gone away.
          // This is sound only because `daemon.shutdown` never calls `daemon.close()`
          // itself — if shutdown ever closed client sockets before exiting, the socket
          // would close first, the poll would return immediately, and this would
          // silently report success even though the process is still exiting.
          const deadline = Date.now() + 2000;
          while (client.isConnected && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 10));
          }
          client.close();
          if (Date.now() >= deadline) {
            throw new CrossweaveError(
              'DAEMON_STOP_TIMEOUT',
              'The daemon acknowledged the shutdown but was still running after 2s.',
            );
          }
          process.stdout.write('daemon stopped\n');
        } catch (err) { fail(err); }
      },
    }),
  },
});

const main = defineCommand({
  meta: { name: 'cw', version: VERSION, description: 'crossweave — parallel agents that stay mergeable' },
  subCommands: {
    init: initCommand,
    workspace: workspaceCommand,
    session: sessionCommand,
    daemon: daemonCommand,
    gc: gcCommand,
    blame: blameCommand,
    'radar-hook': radarHookCommand,
    contract: contractCommand,
    converge: convergeCommand,
    land: landCommand,
    config: configCommand,
  },
});

void runMain(main);
