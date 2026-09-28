import { defineCommand } from 'citty';
import { withClient, fail, currentWorkspaceId } from '../context.js';
import { formatOverlapPairs, type OverlapPair } from './overlap.js';

type OverlapCaller = (method: string, params: Record<string, unknown>) => Promise<{ pairs: OverlapPair[] }>;

/**
 * Prints the overlap section, tolerating a daemon too old to answer `overlap.list`:
 * that RPC is newer than `converge.status`, and a CLI pointed at a daemon started
 * before an update (the `cw`/`cwd` pair is not always restarted together) must still
 * get the verdict rather than an error for a section the daemon never promised.
 */
export async function printOverlaps(
  call: OverlapCaller,
  workspaceId: string,
  out: (text: string) => void = (text) => { process.stdout.write(text); },
): Promise<void> {
  try {
    const { pairs } = await call('overlap.list', { workspaceId });
    if (pairs.length === 0) return;
    out('overlaps:\n');
    for (const line of formatOverlapPairs(pairs).split('\n')) out(`  ${line}\n`);
  } catch {
    // Older daemon without `overlap.list`; the hard verdict already printed stands.
  }
}

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
        // The early warning beside the hard verdict, from its own RPC: the converge
        // status itself must stay cheap (the cockpit polls it), so the overlap scan
        // happens only when a one-shot CLI command asks for it. Printed only when
        // there is something to say, so the common all-clear stays as short as it was.
        await printOverlaps(
          (method, params) => client.call<{ pairs: OverlapPair[] }>(method, params),
          workspaceId,
        );
      });
    } catch (err) { fail(err); }
  },
});

export const convergeCommand = defineCommand({
  meta: { name: 'converge', description: 'Trial-merge status and conflict graph' },
  subCommands: { status: statusCommand },
});
