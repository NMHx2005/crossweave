import { defineCommand } from 'citty';
import { CrossweaveError } from '../../core/errors.js';
import { currentWorkspaceId, fail, withClient } from '../context.js';

export interface CheckVerdict {
  state: 'running' | 'pass' | 'fail';
  ms?: number;
  code?: number;
  tail?: string;
  stale?: boolean;
}

/** One line for the verdict, and the end of the output when it failed. */
export function formatVerdict(name: string, v: CheckVerdict): string {
  const took = v.ms === undefined ? '' : ` (${(v.ms / 1000).toFixed(1)}s)`;
  if (v.state === 'pass') return `${name}: checks pass${took}`;
  if (v.state === 'running') return `${name}: checks running`;
  return `${name}: checks FAIL${v.code === undefined ? '' : ` (exit ${v.code})`}${took}${v.tail ? `\n${v.tail.trimEnd()}` : ''}`;
}

export const checkCommand = defineCommand({
  meta: {
    name: 'check',
    description: 'Run the project\'s trusted converge.testCommand in a session\'s worktree and say whether it passes — is this work fit to land? Exits 1 on failure',
  },
  args: {
    session: { type: 'positional', required: false, description: 'Session name or id (default: this shell\'s own session)' },
    wait: { type: 'boolean', default: true, description: 'Wait for the verdict (--no-wait starts it and returns; the rail shows the result)' },
  },
  async run({ args }) {
    try {
      const idOrName = (typeof args.session === 'string' && args.session !== '' ? args.session : undefined) ?? process.env['CW_SESSION_ID'];
      if (idOrName === undefined || idOrName === '') throw new CrossweaveError('INVALID_ARGUMENTS', 'Name the session: cw check <session> (or run this from a session shell)');
      await withClient(async (client) => {
        const workspaceId = await currentWorkspaceId(client);
        await client.call('session.check', { workspaceId, idOrName });
        if (args.wait === false) return;
        for (;;) {
          await new Promise((r) => setTimeout(r, 1000));
          const list = await client.call<Array<{ id: string; name: string; check?: CheckVerdict }>>('session.list', { workspaceId });
          const row = list.find((s) => s.id === idOrName || s.name === idOrName);
          if (row === undefined) throw new CrossweaveError('SESSION_NOT_FOUND', `No such session: ${idOrName}`);
          if (row.check === undefined || row.check.state === 'running') continue;
          process.stdout.write(`${formatVerdict(row.name, row.check)}\n`);
          if (row.check.state === 'fail') process.exitCode = 1;
          return;
        }
      });
    } catch (err) { fail(err); }
  },
});
