import { CrossweaveError } from '../core/errors.js';
import { ClaudePtyAdapter } from './claude-pty.js';
import { AcpAdapter, type AcpAdapterDeps } from './acp.js';
import { CursorPrintAdapter } from './cursor-print.js';
import type { AgentAdapter } from './types.js';
import { CliPtyAdapter } from './cli-pty.js';
import { resolveAgent } from './catalog.js';
import { loadSettings, type UserSettings } from '../core/settings.js';

/**
 * M5b registers Cursor via native ACP (T1). Claude Code stays on its M5a hook path
 * (T2). Task 3 adds `cursor-print` (T3) — current cursor-agent builds dropped ACP
 * support, so this is the fallback that still works, at the cost of permission
 * interception.
 */
export function createAdapter(kind: string, deps?: AcpAdapterDeps, settings?: UserSettings): AgentAdapter {
  if (kind === 'cursor') {
    if (deps === undefined) {
      throw new CrossweaveError(
        'ADAPTER_DEPS_MISSING',
        'The cursor adapter requires daemon-internal dependencies (resolveWorkspaceId, decideBlocked) that were not provided.',
      );
    }
    return new AcpAdapter(deps);
  }
  if (kind === 'cursor-print') return new CursorPrintAdapter();
  // Everything else comes from the user's agent catalog, read on every call so a
  // change in Settings applies to the next start without a daemon restart.
  const { argv, profile } = resolveAgent(kind, settings ?? loadSettings());
  if (kind === 'claude') {
    const [command, ...args] = argv as [string, ...string[]];
    return new ClaudePtyAdapter(command, args);
  }
  return new CliPtyAdapter(kind, argv, profile);
}
