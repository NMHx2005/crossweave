#!/usr/bin/env node
import { defineCommand, runMain } from 'citty';
import { initCommand, workspaceCommand } from './commands/workspace.js';
import { sessionCommand } from './commands/session.js';
import { withClient, fail } from './context.js';

const daemonCommand = defineCommand({
  meta: { name: 'daemon', description: 'Manage the crossweave daemon' },
  subCommands: {
    stop: defineCommand({
      meta: { name: 'stop', description: 'Stop the daemon for this repository' },
      async run() {
        try {
          await withClient(async (client) => {
            await client.call('daemon.shutdown').catch(() => undefined);
            process.stdout.write('daemon stopped\n');
          });
        } catch (err) { fail(err); }
      },
    }),
  },
});

const main = defineCommand({
  meta: { name: 'cw', description: 'crossweave — parallel agents that stay mergeable' },
  subCommands: {
    init: initCommand,
    workspace: workspaceCommand,
    session: sessionCommand,
    daemon: daemonCommand,
  },
});

void runMain(main);
