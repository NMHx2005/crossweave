#!/usr/bin/env bun
import { join } from 'node:path';
import { defineCommand, runMain } from 'citty';
import { crossweaveDir, findProjectRoot } from '../core/paths.js';
import { VERSION } from '../core/version.js';
import { DaemonClient } from '../client/rpc-client.js';
import { initCommand, workspaceCommand } from './commands/workspace.js';
import { sessionCommand } from './commands/session.js';
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
          client.close();
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
  },
});

void runMain(main);
