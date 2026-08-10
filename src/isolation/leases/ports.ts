import { createServer } from 'node:net';
import { CrossweaveError } from '../../core/errors.js';
import type { CrossweaveConfig } from '../../core/config.js';
import type { LeaseRepo } from '../../db/repositories/lease.js';

/** True when nothing on the loopback interface currently holds this port. */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => resolve(true));
    });
  });
}

/**
 * Find a free contiguous block and return its base port.
 *
 * Two conditions have to hold, and the lease table only covers the first: no other
 * session may hold the block, AND the machine must not already be using it. A port
 * absent from the table is not necessarily free — some unrelated program may own it,
 * and handing it to an agent produces an EADDRINUSE the user has no way to explain.
 *
 * Only the block's first port is probed. Probing all ten would triple the cost of
 * starting a session for a case that does not occur in practice, since blocks are
 * handed out whole.
 *
 * The leased set is snapshotted once and then RE-READ after every successful probe,
 * because `await isPortFree` is a yield point and the daemon dispatches RPCs
 * unserialized: two sessions starting at once can both reach the same candidate before
 * either one's lease row exists. Re-reading immediately before returning closes that —
 * the caller inserts the row with no `await` in between, so nothing can interleave
 * between this check and that write.
 */
export async function allocatePortBlock(
  leases: LeaseRepo,
  config: CrossweaveConfig,
): Promise<number> {
  const taken = new Set(leases.listActive('port').map((l) => Number(l.value)));
  const { base, blockSize } = config.ports;

  for (let candidate = base; candidate + blockSize <= 65536; candidate += blockSize) {
    if (taken.has(candidate)) continue;
    if (await isPortFree(candidate)) {
      for (const lease of leases.listActive('port')) taken.add(Number(lease.value));
      if (taken.has(candidate)) continue;
      return candidate;
    }
  }

  throw new CrossweaveError(
    'NO_PORTS_AVAILABLE',
    `No free port block of ${blockSize} between ${base} and 65535. ` +
      `${taken.size} block(s) are leased; run \`cw gc\` if sessions have ended.`,
  );
}
