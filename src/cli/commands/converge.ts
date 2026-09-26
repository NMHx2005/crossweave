import { defineCommand } from 'citty';
import { withClient, fail, currentWorkspaceId } from '../context.js';

interface ConvergeStatus {
  pairwise: { a: string; b: string; result: string }[];
  fullIntegration: { result: string; ts: string; detail: string | null; baseHead: string } | null;
  recommendedOrder: string[];
  ready: string[];
  unknown: { name: string; reason: string }[];
  blocked: { name: string; reason: string }[];
  /** No commits ahead of the base yet (absent from older daemons). */
  empty?: string[];
  degraded: boolean;
}

const statusCommand = defineCommand({
  meta: { name: 'status', description: 'Show the pairwise conflict matrix and recommended merge order' },
  async run() {
    try {
      await withClient(async (client) => {
        const workspaceId = await currentWorkspaceId(client);
        const status = await client.call<ConvergeStatus>('converge.status', { workspaceId });

        if (status.degraded) {
          process.stdout.write('note: pairwise trials disabled above the session threshold — showing full-integration only\n');
        }
        if (status.pairwise.length === 0) {
          process.stdout.write('no pairwise trials yet\n');
        } else {
          process.stdout.write('PAIR\tRESULT\n');
          for (const p of status.pairwise) process.stdout.write(`${p.a} <-> ${p.b}\t${p.result}\n`);
        }
        process.stdout.write(
          status.fullIntegration
            ? `full integration: ${status.fullIntegration.result} (${status.fullIntegration.ts})\n`
            : 'full integration: not yet run\n',
        );
        process.stdout.write(
          status.recommendedOrder.length > 0
            ? `recommended land order: ${status.recommendedOrder.join(' -> ')}\n`
            : 'recommended land order: (no active sessions)\n',
        );
        process.stdout.write(`ready: ${status.ready.join(', ') || '(none)'}\n`);
        for (const item of status.unknown) {
          process.stdout.write(`unknown: ${item.name} (${item.reason})\n`);
        }
        for (const item of status.blocked) {
          process.stdout.write(`blocked: ${item.name} (${item.reason})\n`);
        }
        if (status.empty !== undefined && status.empty.length > 0) {
          process.stdout.write(`nothing to land yet: ${status.empty.join(', ')}\n`);
        }
      });
    } catch (err) { fail(err); }
  },
});

export const convergeCommand = defineCommand({
  meta: { name: 'converge', description: 'Trial-merge status and conflict graph' },
  subCommands: { status: statusCommand },
});
