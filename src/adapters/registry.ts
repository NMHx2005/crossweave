import { CrossweaveError } from '../core/errors.js';
import { ClaudePtyAdapter } from './claude-pty.js';
import { AcpAdapter, type AcpAdapterDeps } from './acp.js';
import type { AgentAdapter } from './types.js';

/** M5b registers Cursor via native ACP (T1). Claude Code stays on its M5a hook path (T2). */
export function createAdapter(kind: string, deps?: AcpAdapterDeps): AgentAdapter {
  if (kind === 'claude') return new ClaudePtyAdapter();
  if (kind === 'cursor') {
    if (deps === undefined) {
      throw new CrossweaveError(
        'ADAPTER_DEPS_MISSING',
        'The cursor adapter requires daemon-internal dependencies (resolveWorkspaceId, decideBlocked) that were not provided.',
      );
    }
    return new AcpAdapter(deps);
  }
  throw new CrossweaveError(
    'UNKNOWN_AGENT',
    `Unsupported agent kind: ${kind}. Supports: claude, cursor`,
  );
}
