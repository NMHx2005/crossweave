import { defineCommand } from 'citty';
import { CrossweaveError } from '../../core/errors.js';
import {
  chooseNextLand,
  landAllLoop,
  type ConvergeStatus,
  type LandResult,
} from '../../convergence/land-order.js';
import { withClient, fail, currentWorkspaceId } from '../context.js';

export { chooseNextLand };

export function assertLandConfirmed(yes: boolean): void {
  if (!yes) {
    throw new CrossweaveError(
      'CONFIRMATION_REQUIRED',
      'Landing merges the session\'s branch into the base branch and removes its worktree. Re-run with --yes.',
    );
  }
}

function printLandResult(name: string, result: LandResult): void {
  process.stdout.write(`landed ${name} into ${result.baseBranch} (tested: ${result.tested})\n`);
  for (const warning of result.warnings) {
    process.stdout.write(`warning: ${warning}\n`);
  }
}

const singleCommand = defineCommand({
  meta: { name: 'session', description: "Land one session's branch into the base branch" },
  args: {
    target: { type: 'positional', description: 'Session name or id' },
    force: { type: 'boolean', default: false, description: 'Land even if the session is still running' },
    yes: { type: 'boolean', default: false, description: 'Skip confirmation' },
  },
  async run({ args }) {
    try {
      if (args.target === undefined) {
        throw new CrossweaveError('INVALID_ARGUMENTS', 'Missing required argument: TARGET');
      }
      assertLandConfirmed(args.yes);
      await withClient(async (client) => {
        const workspaceId = await currentWorkspaceId(client);
        const result = await client.call<LandResult>('land.session', {
          workspaceId, idOrName: args.target, force: args.force,
        });
        printLandResult(args.target as string, result);
      });
    } catch (err) { fail(err); }
  },
});

const allCommand = defineCommand({
  meta: { name: 'all', description: 'Land every evidence-ready session, stopping at the first failure' },
  args: {
    force: { type: 'boolean', default: false, description: 'Land even sessions still running' },
    yes: { type: 'boolean', default: false, description: 'Skip confirmation' },
  },
  async run({ args }) {
    try {
      assertLandConfirmed(args.yes);
      await withClient(async (client) => {
        const workspaceId = await currentWorkspaceId(client);
        let lastStatus: ConvergeStatus = { ready: [], unknown: [], blocked: [] };
        const result = await landAllLoop({
          getStatus: async () => {
            lastStatus = await client.call<ConvergeStatus>('converge.status', { workspaceId });
            return lastStatus;
          },
          land: async (name) => {
            const candidate = chooseNextLand(lastStatus, args.force);
            if (candidate?.warning !== undefined) {
              process.stdout.write(`warning: landing ${name} with incomplete evidence: ${candidate.warning}\n`);
            }
            return client.call<LandResult>('land.session', {
              workspaceId, idOrName: name, force: args.force,
            });
          },
          force: args.force,
          onProgress: (name, landResult) => printLandResult(name, landResult),
        });
        if (result.failedAt !== undefined) {
          process.stdout.write(`stopped at ${result.failedAt}: ${result.error ?? 'failed'}\n`);
          process.exitCode = 1;
          return;
        }
        if (result.landed.length === 0) {
          process.stdout.write('nothing to land\n');
          if (!args.force && lastStatus.unknown[0] !== undefined) {
            process.stderr.write(`${lastStatus.unknown[0].reason}\n`);
          }
        }
      });
    } catch (err) { fail(err); }
  },
});

export const landCommand = defineCommand({
  meta: { name: 'land', description: 'Merge a session\'s work into the base branch' },
  subCommands: { session: singleCommand, all: allCommand },
});
