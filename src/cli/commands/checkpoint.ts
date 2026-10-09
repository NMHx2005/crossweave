import { defineCommand } from 'citty';
import { CrossweaveError } from '../../core/errors.js';
import { currentWorkspaceId, fail, withClient } from '../context.js';

export interface CliCheckpoint {
  seq: number;
  kind: string;
  label?: string;
  at: number;
  head: string;
  tree: string;
  files: { added: number; modified: number; deleted: number };
}

export function formatCheckpoint(c: CliCheckpoint): string {
  const counts = `+${c.files.added} ~${c.files.modified} -${c.files.deleted}`;
  return `#${c.seq}  ${c.kind}  ${c.label === undefined ? '' : `${c.label}  `}${counts}`;
}

export function formatPlan(plan: { write: string[]; delete: string[] }): string {
  const lines = [...plan.write.map((p) => `write ${p}`), ...plan.delete.map((p) => `delete ${p}`)];
  return lines.length === 0 ? 'nothing to change' : lines.join('\n');
}

function sessionArg(value: unknown): string {
  const idOrName = (typeof value === 'string' && value !== '' ? value : undefined) ?? process.env['CW_SESSION_ID'];
  if (idOrName === undefined || idOrName === '') {
    throw new CrossweaveError('INVALID_ARGUMENTS', 'Name the session: cw checkpoint <verb> [session] (or run this from a session shell)');
  }
  return idOrName;
}

function seqArg(value: unknown, what: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new CrossweaveError('INVALID_ARGUMENTS', `${what} must be a checkpoint number, like 3`);
  return n;
}

const sessionPositional = { type: 'positional', required: false, description: 'Session name or id (default: this shell\'s own session)' } as const;
const sessionFlag = { type: 'string', description: 'Session name or id (default: this shell\'s own session)' } as const;

export const checkpointCommand = defineCommand({
  meta: { name: 'checkpoint', description: 'Snapshots of a session\'s worktree, taken as its agent starts and finishes a turn: list them, diff a turn, take the files back' },
  subCommands: {
    list: defineCommand({
      meta: { name: 'list', description: 'List a session\'s checkpoints, newest first' },
      args: { session: sessionPositional },
      async run({ args }) {
        try {
          const idOrName = sessionArg(args.session);
          await withClient(async (client) => {
            const workspaceId = await currentWorkspaceId(client);
            const out = await client.call<{ checkpoints: CliCheckpoint[] }>('checkpoint.list', { workspaceId, idOrName });
            process.stdout.write(out.checkpoints.length === 0 ? 'no checkpoints yet\n' : `${out.checkpoints.map(formatCheckpoint).join('\n')}\n`);
          });
        } catch (err) { fail(err); }
      },
    }),
    take: defineCommand({
      meta: { name: 'take', description: 'Take a checkpoint now' },
      args: { session: sessionPositional, label: { type: 'string', description: 'A short note for this checkpoint' } },
      async run({ args }) {
        try {
          const idOrName = sessionArg(args.session);
          await withClient(async (client) => {
            const workspaceId = await currentWorkspaceId(client);
            const out = await client.call<CliCheckpoint | { unchanged: true; seq: number }>('checkpoint.take', {
              workspaceId, idOrName, ...(typeof args.label === 'string' ? { label: args.label } : {}),
            });
            process.stdout.write('unchanged' in out ? `unchanged since #${out.seq}\n` : `${formatCheckpoint(out)}\n`);
          });
        } catch (err) { fail(err); }
      },
    }),
    diff: defineCommand({
      meta: { name: 'diff', description: 'Print the patch between two checkpoints, or from one to the worktree as it is now' },
      args: {
        from: { type: 'positional', required: true, description: 'Checkpoint number' },
        to: { type: 'positional', required: false, description: 'Checkpoint number (default: the live worktree)' },
        session: sessionFlag,
      },
      async run({ args }) {
        try {
          const idOrName = sessionArg(args.session);
          const from = seqArg(args.from, 'from');
          const to = args.to === undefined ? undefined : seqArg(args.to, 'to');
          await withClient(async (client) => {
            const workspaceId = await currentWorkspaceId(client);
            const out = await client.call<{ patch: string; truncated: boolean }>('checkpoint.diff', { workspaceId, idOrName, from, ...(to === undefined ? {} : { to }) });
            process.stdout.write(out.patch === '' ? 'no differences\n' : out.patch);
            if (out.truncated) process.stderr.write('(patch cut at 512 KB)\n');
          });
        } catch (err) { fail(err); }
      },
    }),
    restore: defineCommand({
      meta: { name: 'restore', description: 'Put a checkpoint\'s files back. Prints the plan; nothing is written without --apply. A return point is saved first' },
      args: {
        seq: { type: 'positional', required: true, description: 'Checkpoint number' },
        session: sessionFlag,
        apply: { type: 'boolean', default: false, description: 'Actually write the files' },
        force: { type: 'boolean', default: false, description: 'Restore even though the session looks busy' },
      },
      async run({ args }) {
        try {
          const idOrName = sessionArg(args.session);
          const seq = seqArg(args.seq, 'seq');
          await withClient(async (client) => {
            const workspaceId = await currentWorkspaceId(client);
            const out = await client.call<{ plan: { write: string[]; delete: string[] }; applied: boolean; preRestoreSeq?: number }>(
              'checkpoint.restore', { workspaceId, idOrName, seq, apply: args.apply === true, force: args.force === true },
            );
            process.stdout.write(`${formatPlan(out.plan)}\n`);
            process.stdout.write(out.applied
              ? `restored #${seq}; to undo: cw checkpoint restore ${out.preRestoreSeq ?? '?'} --apply\n`
              : 'preview only — add --apply to write these files\n');
          });
        } catch (err) { fail(err); }
      },
    }),
  },
});
