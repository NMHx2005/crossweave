import { defineCommand } from 'citty';
import { withClient, fail } from '../context.js';

interface Workspace { id: string; name: string; rootPath: string }
interface Session { id: string; name: string; status: string; enforcementTier: string }

export const initCommand = defineCommand({
  meta: { name: 'init', description: 'Create or attach the workspace for this repository' },
  args: { name: { type: 'string', description: 'Workspace name (defaults to the directory name)' } },
  async run({ args }) {
    try {
      await withClient(async (client) => {
        const params = args.name ? { name: args.name } : {};
        const ws = await client.call<Workspace>('workspace.init', params);
        process.stdout.write(`workspace ${ws.name} (${ws.id})\n${ws.rootPath}\n`);
      });
    } catch (err) { fail(err); }
  },
});

export const workspaceCommand = defineCommand({
  meta: { name: 'workspace', description: 'Manage workspaces' },
  subCommands: {
    list: defineCommand({
      meta: { name: 'list', description: 'List workspaces' },
      async run() {
        try {
          await withClient(async (client) => {
            const rows = await client.call<Workspace[]>('workspace.list');
            if (rows.length === 0) { process.stdout.write('no workspaces\n'); return; }
            for (const w of rows) process.stdout.write(`${w.name}\t${w.id}\t${w.rootPath}\n`);
          });
        } catch (err) { fail(err); }
      },
    }),

    info: defineCommand({
      meta: { name: 'info', description: 'Show the current workspace and its sessions' },
      async run() {
        try {
          await withClient(async (client) => {
            const ws = await client.call<Workspace>('workspace.init', {});
            const info = await client.call<{ workspace: Workspace; sessions: Session[] }>(
              'workspace.info', { id: ws.id },
            );
            process.stdout.write(`${info.workspace.name}\t${info.workspace.rootPath}\n`);
            process.stdout.write(`sessions: ${info.sessions.length}\n`);
            for (const s of info.sessions) {
              process.stdout.write(`  ${s.name}\t${s.status}\t${s.enforcementTier}\n`);
            }
          });
        } catch (err) { fail(err); }
      },
    }),

    delete: defineCommand({
      meta: { name: 'delete', description: 'Delete a workspace' },
      args: {
        name: { type: 'positional', description: 'Workspace name or id' },
        force: { type: 'boolean', description: 'Delete even with live sessions', default: false },
      },
      async run({ args }) {
        try {
          await withClient(async (client) => {
            await client.call('workspace.delete', { id: args.name, force: args.force });
            process.stdout.write(`deleted ${args.name}\n`);
          });
        } catch (err) { fail(err); }
      },
    }),
  },
});
