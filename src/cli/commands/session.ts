import { defineCommand } from 'citty';
import { CrossweaveError } from '../../core/errors.js';
import { withClient, fail, currentWorkspaceId } from '../context.js';
import { attachCommand } from './attach.js';

interface Session {
  id: string; name: string; status: string; agentKind: string;
  enforcementTier: string; worktreePath: string | null; branch: string | null;
}

export const sessionCommand = defineCommand({
  meta: { name: 'session', description: 'Manage sessions' },
  subCommands: {
    attach: attachCommand,

    new: defineCommand({
      meta: { name: 'new', description: 'Create a session' },
      // citty derives `--no-worktree` automatically from a boolean named `worktree`,
      // so declaring a literal `no-worktree` flag would collide with that negation.
      args: {
        name: { type: 'string', required: true, description: 'Session name' },
        agent: { type: 'string', default: 'claude', description: 'Agent kind' },
        worktree: { type: 'boolean', default: true, description: 'Isolate in a git worktree' },
      },
      async run({ args }) {
        try {
          await withClient(async (client) => {
            const workspaceId = await currentWorkspaceId(client);
            const worktree = args.worktree;
            if (!worktree) {
              process.stderr.write(
                'warning: --no-worktree shares the project root. ' +
                  'Sessions can overwrite each other\'s files.\n',
              );
            }
            const s = await client.call<Session>('session.new', {
              workspaceId, name: args.name, agent: args.agent, worktree,
            });
            process.stdout.write(
              `${s.name}\t${s.status}\t${s.enforcementTier}\t${s.worktreePath ?? '-'}\n`,
            );
          });
        } catch (err) { fail(err); }
      },
    }),

    list: defineCommand({
      meta: { name: 'list', description: 'List sessions' },
      async run() {
        try {
          await withClient(async (client) => {
            const workspaceId = await currentWorkspaceId(client);
            const rows = await client.call<Session[]>('session.list', { workspaceId });
            if (rows.length === 0) { process.stdout.write('no sessions\n'); return; }
            process.stdout.write('NAME\tSTATUS\tAGENT\tTIER\tBRANCH\n');
            for (const s of rows) {
              process.stdout.write(
                `${s.name}\t${s.status}\t${s.agentKind}\t${s.enforcementTier}\t${s.branch ?? '-'}\n`,
              );
            }
          });
        } catch (err) { fail(err); }
      },
    }),

    rename: defineCommand({
      meta: { name: 'rename', description: 'Rename a session' },
      args: {
        target: { type: 'positional', description: 'Session name or id' },
        newName: { type: 'positional', description: 'New name' },
      },
      async run({ args }) {
        try {
          await withClient(async (client) => {
            const workspaceId = await currentWorkspaceId(client);
            const s = await client.call<Session>('session.rename', {
              workspaceId, idOrName: args.target, newName: args.newName,
            });
            process.stdout.write(`${s.name}\n`);
          });
        } catch (err) { fail(err); }
      },
    }),

    kill: defineCommand({
      meta: { name: 'kill', description: 'Kill a session' },
      args: {
        target: { type: 'positional', description: 'Session name or id' },
        'rm-worktree': { type: 'boolean', default: false, description: 'Also remove the worktree' },
        yes: { type: 'boolean', default: false, description: 'Skip confirmation' },
      },
      async run({ args }) {
        try {
          // Goes through fail() like every other error path. A guard that printed its
          // own format would be the one place a script could not parse, and this is
          // the destructive one.
          if (args['rm-worktree'] && !args.yes) {
            throw new CrossweaveError(
              'CONFIRMATION_REQUIRED',
              'Refusing to remove a worktree without confirmation. Re-run with --yes.',
            );
          }
          await withClient(async (client) => {
            const workspaceId = await currentWorkspaceId(client);
            await client.call('session.kill', {
              workspaceId, idOrName: args.target, removeWorktree: args['rm-worktree'],
            });
            process.stdout.write(`killed ${args.target}\n`);
          });
        } catch (err) { fail(err); }
      },
    }),
  },
});
