import { defineCommand } from 'citty';
import { CrossweaveError } from '../../core/errors.js';
import { withClient, fail, currentWorkspaceId } from '../context.js';
import { attachCommand } from './attach.js';

interface Session {
  id: string; name: string; status: string;
  worktreePath: string | null; branch: string | null;
  leases?: LeaseSummary;
}

interface LeaseSummary {
  portBase: number | null;
  composeProject: string | null;
  cachePath: string | null;
  dbStrategy: 'none' | 'schema' | 'file-copy';
  dbValue: string | null;
}

export function formatLeaseSummary(leases: LeaseSummary | undefined): string {
  if (leases === undefined) return '-';
  const parts: string[] = [];
  if (leases.portBase !== null) parts.push(`port=${leases.portBase}`);
  if (leases.composeProject !== null) parts.push(`compose=${leases.composeProject}`);
  if (leases.cachePath !== null) parts.push(`cache=${leases.cachePath}`);
  if (leases.dbStrategy !== 'none' && leases.dbValue !== null) {
    parts.push(`db=${leases.dbStrategy}:${leases.dbValue}`);
  }
  return parts.length === 0 ? '-' : parts.join(',');
}

export const sessionCommand = defineCommand({
  meta: { name: 'session', description: 'Manage sessions' },
  subCommands: {
    attach: attachCommand,

    new: defineCommand({
      meta: { name: 'new', description: 'Create a session: a worktree and a shell in it (start the shell with cw session start)' },
      // citty derives `--no-worktree` automatically from a boolean named `worktree`,
      // so declaring a literal `no-worktree` flag would collide with that negation.
      args: {
        // Positional like every other session verb; `--name` still works.
        sessionName: { type: 'positional', required: false, description: 'Session name' },
        name: { type: 'string', description: 'Session name (same as the positional)' },
        worktree: { type: 'boolean', default: true, description: 'Isolate in a git worktree' },
        base: { type: 'string', description: 'Branch or commit to start the worktree from (default: HEAD)' },
      },
      async run({ args }) {
        try {
          const name = args.sessionName ?? args.name;
          if (name === undefined || name === '') {
            throw new CrossweaveError('INVALID_ARGUMENTS', 'Missing session name: cw session new <name>');
          }
          await withClient(async (client) => {
            const workspaceId = await currentWorkspaceId(client);
            const worktree = args.worktree;
            if (!worktree) {
              process.stderr.write(
                'warning: --no-worktree shares the project root. ' +
                  'Sessions can overwrite each other\'s files.\n',
              );
            }
            // Creates, and stops there. The standard verb split: `new` makes the
            // thing, `start` runs it, and `attach` starts it for you when you are about
            // to look at it. An earlier version also spawned the agent here, which
            // meant `new` allocated ~400MB of agent per call and failed outright
            // wherever that binary is absent (CI) — for a convenience the other two
            // verbs already provide.
            const created = await client.call<Session>('session.new', {
              workspaceId, name, worktree,
              ...(args.base === undefined ? {} : { base: args.base }),
            });
            process.stdout.write(`${created.name}\t${created.status}\t${created.worktreePath ?? '-'}\n`);
          });
        } catch (err) { fail(err); }
      },
    }),

    list: defineCommand({
      meta: { name: 'list', description: 'List sessions with their branch and runtime leases' },
      async run() {
        try {
          await withClient(async (client) => {
            const workspaceId = await currentWorkspaceId(client);
            const rows = await client.call<Session[]>('session.list', { workspaceId });
            if (rows.length === 0) { process.stdout.write('no sessions\n'); return; }
            process.stdout.write('NAME\tSTATUS\tBRANCH\tLEASES\n');
            for (const s of rows) {
              process.stdout.write(`${s.name}\t${s.status}\t${s.branch ?? '-'}\t${formatLeaseSummary(s.leases)}\n`);
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

    // Worktree directories are named by session id, deliberately: the id survives
    // `rename` and never collides when a name is reused after `rm`. This is how a
    // person gets from the name they know to the directory: `cd $(cw session path x)`.
    path: defineCommand({
      meta: { name: 'path', description: "Print a session's worktree path (cd $(cw session path <name>))" },
      args: { target: { type: 'positional', description: 'Session name or id', required: false } },
      async run({ args }) {
        try {
          if (args.target === undefined) {
            throw new CrossweaveError('INVALID_ARGUMENTS', 'Missing session name: cw session path <name>');
          }
          const target = args.target;
          await withClient(async (client) => {
            const workspaceId = await currentWorkspaceId(client);
            const sessions = await client.call<Session[]>('session.list', { workspaceId });
            const row = sessions.find((s) => s.name === target || s.id === target);
            if (row === undefined) throw new CrossweaveError('SESSION_NOT_FOUND', `No such session: ${target}`);
            if (row.worktreePath === null) {
              throw new CrossweaveError('SESSION_NO_WORKDIR', `Session has no working directory: ${row.name}`);
            }
            process.stdout.write(`${row.worktreePath}\n`);
          });
        } catch (err) { fail(err); }
      },
    }),

    // Without this the stop/kill distinction exists only over RPC, and the decision
    // that `kill` is terminal has no escape hatch a user can reach — SESSION_ENDED
    // would be advising a command that does not exist.
    start: defineCommand({
      meta: { name: 'start', description: "Open the session's shell again (a stopped session); run your tools in it yourself" },
      // Optional + validated by hand for the same reason `stop` does it: citty's own
      // missing-positional error has no `CODE:` prefix, which would break the contract
      // that every CLI failure emits exactly one `CODE: message` line.
      args: { target: { type: 'positional', description: 'Session name or id', required: false } },
      async run({ args }) {
        try {
          if (args.target === undefined) {
            throw new CrossweaveError('INVALID_ARGUMENTS', 'Missing required argument: TARGET');
          }
          await withClient(async (client) => {
            const workspaceId = await currentWorkspaceId(client);
            const row = await client.call<Session>('session.resume', {
              workspaceId, idOrName: args.target, env: { ...process.env },
            });
            process.stdout.write(`${row.name}\t${row.status}\t${row.worktreePath ?? '-'}\n`);
          });
        } catch (err) { fail(err); }
      },
    }),

    stop: defineCommand({
      meta: { name: 'stop', description: "Close the session's shell (and whatever runs in it); the worktree stays" },
      // Declared optional, not required: citty's own missing-positional error has no
      // `CODE:` prefix (it prints usage + a bare message and calls process.exit(1)
      // itself, never rejecting runMain's promise), which breaks the contract that
      // every CLI failure path emits exactly one `CODE: message` line. Validating it
      // ourselves keeps that path going through fail() like every other error.
      args: { target: { type: 'positional', description: 'Session name or id', required: false } },
      async run({ args }) {
        try {
          if (args.target === undefined) {
            throw new CrossweaveError('INVALID_ARGUMENTS', 'Missing required argument: TARGET');
          }
          await withClient(async (client) => {
            const workspaceId = await currentWorkspaceId(client);
            await client.call('session.stop', { workspaceId, idOrName: args.target });
            process.stdout.write(`stopped ${args.target}\n`);
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

    rm: defineCommand({
      meta: { name: 'rm', description: 'Purge an ended session: its worktree, branch and record' },
      args: {
        target: { type: 'positional', description: 'Session name or id' },
        yes: { type: 'boolean', default: false, description: 'Skip confirmation' },
      },
      async run({ args }) {
        try {
          if (!args.yes) {
            throw new CrossweaveError(
              'CONFIRMATION_REQUIRED',
              'Removing a session deletes its worktree and branch. Re-run with --yes.',
            );
          }
          await withClient(async (client) => {
            const workspaceId = await currentWorkspaceId(client);
            await client.call('session.rm', { workspaceId, idOrName: args.target });
            process.stdout.write(`removed ${args.target}\n`);
          });
        } catch (err) { fail(err); }
      },
    }),
  },
});
