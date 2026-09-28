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

/**
 * The lifecycle hooks' trust, kept separate from the test command's on purpose:
 * `sessionSetup` is typed into a shell automatically on a session's first start, while
 * `testCommand` runs only on an explicit `cw land --yes`. Gating them together would let
 * a user trusting their test command unknowingly arm a hook a hostile clone added, so
 * each is hashed and trusted on its own.
 *
 * A canonical serialization (fixed keys, empty for the absent side) so the hash does not
 * depend on which keys the file happened to spell out.
 */
export function hashHooks(hooks: { sessionSetup?: string; sessionTeardown?: string }): string {
  const canonical = JSON.stringify({
    setup: hooks.sessionSetup ?? '',
    teardown: hooks.sessionTeardown ?? '',
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function isHooksTrusted(
  hooks: { sessionSetup?: string; sessionTeardown?: string },
  configTrust: ConfigTrustRepo,
  workspaceId: string,
): boolean {
  const trust = configTrust.get(workspaceId);
  return trust?.hooksHash !== undefined && trust.hooksHash === hashHooks(hooks);
}
