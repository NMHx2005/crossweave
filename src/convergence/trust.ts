import { createHash } from 'node:crypto';
import type { ConfigTrustRepo } from '../db/repositories/config-trust.js';

/** Any change to the command string must invalidate trust, so trust is keyed by its hash, not a boolean. */
export function hashTestCommand(command: string): string {
  return createHash('sha256').update(command).digest('hex');
}

/**
 * `converge.testCommand` is sourced from `crossweave.config.json`, a file the repo
 * itself controls — a workspace must have explicitly trusted the CURRENT command
 * string (via `cw config trust`) before it is allowed to run. Editing the string,
 * including by cloning a repo that changed it, drops trust again.
 */
export function isTestCommandTrusted(testCommand: string, configTrust: ConfigTrustRepo, workspaceId: string): boolean {
  const trust = configTrust.get(workspaceId);
  return trust !== undefined && trust.testCommandHash === hashTestCommand(testCommand);
}
