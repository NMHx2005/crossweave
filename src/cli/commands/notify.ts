import { defineCommand } from 'citty';
import { CrossweaveError } from '../../core/errors.js';
import { currentWorkspaceId, fail, sessionForCwd, withClient } from '../context.js';

export interface NotifyRequest {
  idOrName: string;
  kind: 'done' | 'ask';
  message: string;
}

/**
 * What a `cw notify` line stands for. The session defaults to the one this shell belongs to
 * (`CW_SESSION_ID`, set in every session), so an agent's hook needs no arguments beyond the words.
 * The daemon validates again; this is the friendly front door.
 */
export function buildNotifyRequest(
  words: readonly string[],
  flags: Readonly<{ kind?: string; session?: string }>,
  env: Readonly<Record<string, string | undefined>>,
): NotifyRequest {
  const kind = flags.kind ?? 'done';
  if (kind !== 'done' && kind !== 'ask') throw new CrossweaveError('INVALID_ARGUMENTS', '--kind takes done or ask');
  const idOrName = flags.session ?? env['CW_SESSION_ID'];
  if (idOrName === undefined || idOrName === '') {
    throw new CrossweaveError('INVALID_ARGUMENTS', 'Name the session with --session (or run this from a session shell)');
  }
  return { idOrName, kind, message: words.join(' ') };
}

export const notifyCommand = defineCommand({
  meta: {
    name: 'notify',
    description: 'Tell the cockpit this session is done (or needs an answer): a mark on its row and, when you are away, a notification. Meant for an agent\'s hook: cw notify "tests written"',
  },
  args: {
    message: { type: 'positional', required: false, description: 'A short line to show (up to 200 characters)' },
    kind: { type: 'string', description: 'done (default) or ask' },
    session: { type: 'string', description: 'Session name or id (default: this shell\'s own session)' },
  },
  async run({ args, rawArgs }) {
    try {
      // Every positional word is the message, so it needs no quoting.
      const words: string[] = [];
      for (let i = 0; i < rawArgs.length; i++) {
        const a = rawArgs[i] as string;
        if (a === '--kind' || a === '--session') { i++; continue; }
        if (a.startsWith('--kind=') || a.startsWith('--session=')) continue;
        words.push(a);
      }
      const flags = {
        ...(typeof args.kind === 'string' ? { kind: args.kind } : {}),
        ...(typeof args.session === 'string' ? { session: args.session } : {}),
      };
      if (flags.session === undefined && process.env['CW_SESSION_ID'] === undefined) {
        // A hook shell can run with the variable gone (an agent launched from a
        // launcher that dropped the env): resolve by where the shell stands — the
        // session's own worktree. The daemon validates again.
        await withClient(async (client) => {
          const workspaceId = await currentWorkspaceId(client);
          const rows = await client.call<Array<{ name: string; worktreePath: string | null }>>('session.list', { workspaceId });
          const name = sessionForCwd(rows, process.cwd());
          if (name === undefined) {
            throw new CrossweaveError('INVALID_ARGUMENTS', 'Name the session with --session (or run this from a session shell)');
          }
          const req = buildNotifyRequest(words, flags, { CW_SESSION_ID: name });
          await client.call('session.notify', { workspaceId, ...req });
        });
        return;
      }
      const req = buildNotifyRequest(words, flags, process.env);
      await withClient(async (client) => {
        const workspaceId = await currentWorkspaceId(client);
        await client.call('session.notify', { workspaceId, ...req });
      });
    } catch (err) { fail(err); }
  },
});
