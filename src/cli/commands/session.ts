import { defineCommand } from 'citty';
import { CrossweaveError } from '../../core/errors.js';
import { withClient, fail, currentWorkspaceId } from '../context.js';
import { attachCommand } from './attach.js';

interface Session {
  id: string; name: string; status: string; agentKind: string;
  enforcementTier: string; worktreePath: string | null; branch: string | null;
  tokenSpent: number; tokenBudget: number | null;
  costSpentUsd: number; costBudgetUsd: number | null;
}

/** The subset of Session's fields formatSpend needs — kept separate so the CLI unit
 * tests (tests/cli/session.test.ts) can pass a plain object without every field. */
interface SpendFields {
  tokenSpent: number; tokenBudget: number | null;
  costSpentUsd: number; costBudgetUsd: number | null;
}

/** Exported for direct testing. citty has no numeric arg type (only string, boolean,
 * positional, enum) — flags declared `type: 'string'` are parsed here instead. */
export function parseOptionalNumberArg(flag: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new CrossweaveError('INVALID_ARGUMENTS', `${flag} must be a number, got: ${raw}`);
  }
  return n;
}

/**
 * Always shows current spend (design doc §1: "cw session list showing real, live
 * spend" is M6a's own success criterion, independent of whether a budget is set) and
 * appends a plain-text "OVER BUDGET" marker — no color/TTY-detection logic, matching
 * this CLI's tab-separated, script-parseable output convention — when spend exceeds a
 * budget that IS set. Exported for direct testing.
 */
export function formatSpend(s: SpendFields): string {
  const costPart = `$${s.costSpentUsd.toFixed(4)}`;
  const tokenPart = `${(s.tokenSpent / 1000).toFixed(1)}k`;
  const overCost = s.costBudgetUsd !== null && s.costSpentUsd > s.costBudgetUsd;
  const overTokens = s.tokenBudget !== null && s.tokenSpent > s.tokenBudget;
  const marker = overCost || overTokens ? ' OVER BUDGET' : '';
  return `${costPart}/${tokenPart}${marker}`;
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
        'budget-tokens': { type: 'string', description: 'Warn once cumulative tokens spent exceeds this' },
        'budget-usd': { type: 'string', description: 'Warn once cumulative cost (USD) exceeds this' },
      },
      async run({ args }) {
        try {
          const budgetTokens = parseOptionalNumberArg('--budget-tokens', args['budget-tokens']);
          const budgetUsd = parseOptionalNumberArg('--budget-usd', args['budget-usd']);
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
              workspaceId, name: args.name, agent: args.agent, worktree, budgetTokens, budgetUsd,
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
            process.stdout.write('NAME\tSTATUS\tAGENT\tTIER\tBRANCH\tSPEND\n');
            for (const s of rows) {
              process.stdout.write(
                `${s.name}\t${s.status}\t${s.agentKind}\t${s.enforcementTier}\t${s.branch ?? '-'}\t${formatSpend(s)}\n`,
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

    // Without this the stop/kill distinction exists only over RPC, and the decision
    // that `kill` is terminal has no escape hatch a user can reach — SESSION_ENDED
    // would be advising a command that does not exist.
    stop: defineCommand({
      meta: { name: 'stop', description: 'Stop the agent but keep the session resumable' },
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
