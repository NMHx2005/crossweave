import { defineCommand } from 'citty';
import { withClient, fail, currentWorkspaceId } from '../context.js';

export interface OverlapPair {
  a: string;
  b: string;
  paths: string[];
}

/** One line per pair, stable and parseable: `NAME <-> NAME<TAB>path, path`. */
export function formatOverlapPairs(pairs: readonly OverlapPair[]): string {
  return pairs.map((pair) => `${pair.a} <-> ${pair.b}\t${pair.paths.join(', ')}`).join('\n');
}

export const overlapCommand = defineCommand({
  meta: {
    name: 'overlap',
    description: 'Which sessions are touching the same files — the early warning before a trial merge conflicts',
  },
  args: {
    json: { type: 'boolean', default: false, description: 'Machine-readable output' },
  },
  async run({ args }) {
    try {
      await withClient(async (client) => {
        const workspaceId = await currentWorkspaceId(client);
        const { pairs } = await client.call<{ pairs: OverlapPair[] }>('overlap.list', { workspaceId });
        if (args.json) {
          process.stdout.write(`${JSON.stringify(pairs)}\n`);
          return;
        }
        process.stdout.write(pairs.length === 0 ? 'no overlaps\n' : `${formatOverlapPairs(pairs)}\n`);
      });
    } catch (err) { fail(err); }
  },
});
