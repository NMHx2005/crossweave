import { realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { defineCommand } from 'citty';
import { withClient, fail, currentWorkspaceId } from '../context.js';
import { CrossweaveError } from '../../core/errors.js';
import { assertContained } from '../../core/paths.js';

export function parseContractTarget(target: string): { symbolFqn: string; path: string; name: string } {
  const hashIndex = target.lastIndexOf('#');
  if (hashIndex === -1) {
    throw new CrossweaveError('INVALID_ARGUMENTS', `Expected <file>#<Name>, e.g. src/auth.ts#AuthService, got: ${target}`);
  }
  return { symbolFqn: target, path: target.slice(0, hashIndex), name: target.slice(hashIndex + 1) };
}

const declareCommand = defineCommand({
  meta: { name: 'declare', description: "Pin a symbol's current signature as a contract" },
  args: {
    symbol: { type: 'positional', description: '<file>#<Name>', required: true },
    session: { type: 'string', description: 'Session id or name declaring this contract', required: true },
    'stable-by': { type: 'string', description: 'ISO 8601 timestamp this contract is expected to hold until', required: false },
  },
  async run({ args }) {
    try {
      const { symbolFqn, path } = parseContractTarget(args.symbol);
      await withClient(async (client, projectRoot) => {
        const workspaceId = await currentWorkspaceId(client);
        const root = realpathSync(projectRoot);
        // Still worth rejecting an escaping path early, even though the daemon
        // resolves the actual read (from the declaring session's own worktree,
        // not this main checkout — see `contract.declare`'s RPC handler).
        const repoRelativePath = relative(root, assertContained(root, resolve(process.cwd(), path)));
        const result = await client.call<{ id: string; symbolFqn: string; sigHash: string }>('contract.declare', {
          workspaceId,
          sessionId: args.session,
          symbolFqn: `${repoRelativePath}#${symbolFqn.slice(symbolFqn.lastIndexOf('#') + 1)}`,
          stableBy: args['stable-by'],
        });
        process.stdout.write(`declared ${result.symbolFqn} (sig ${result.sigHash.slice(0, 8)})\n`);
      });
    } catch (err) { fail(err); }
  },
});

export const contractCommand = defineCommand({
  meta: { name: 'contract', description: 'Manage symbol contracts' },
  subCommands: { declare: declareCommand },
});
