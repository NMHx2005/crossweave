import { defineCommand } from 'citty';
import { CrossweaveError } from '../../core/errors.js';
import { withClient, fail, currentWorkspaceId } from '../context.js';

interface LandResult {
  status: 'landed';
  tested: 'clean' | 'unverified';
  baseBranch: string;
  warnings: string[];
}
interface ConvergeStatus {
  ready: string[];
  unknown: { name: string; reason: string }[];
  blocked: { name: string; reason: string }[];
}

export function chooseNextLand(
  status: ConvergeStatus,
  force: boolean,
): { name: string; warning?: string } | undefined {
  const ready = status.ready[0];
  if (ready !== undefined) return { name: ready };
  if (!force) return undefined;
  const unknown = status.unknown[0];
  return unknown === undefined
    ? undefined
    : { name: unknown.name, warning: unknown.reason };
}

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
        let landedAny = false;
        while (true) {
          const status = await client.call<ConvergeStatus>('converge.status', { workspaceId });
          const candidate = chooseNextLand(status, args.force);
          if (candidate === undefined) {
            if (!landedAny) process.stdout.write('nothing to land\n');
            if (!args.force && status.unknown[0] !== undefined) {
              process.stderr.write(`${status.unknown[0].reason}\n`);
            }
            return;
          }
          const { name, warning } = candidate;
          if (warning !== undefined) {
            process.stdout.write(`warning: landing ${name} with incomplete evidence: ${warning}\n`);
          }
          try {
            const result = await client.call<LandResult>('land.session', {
              workspaceId, idOrName: name, force: args.force,
            });
            printLandResult(name, result);
            landedAny = true;
          } catch (err) {
            process.stdout.write(`stopped at ${name}: ${(err as Error).message}\n`);
            process.exitCode = 1;
            return;
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
