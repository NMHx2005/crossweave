import { CrossweaveError } from '../core/errors.js';
import { ClaudePtyAdapter } from './claude-pty.js';
import type { AgentAdapter } from './types.js';

/** M5 registers the ACP client and Cursor here. M0 supports Claude Code only. */
export function createAdapter(kind: string): AgentAdapter {
  if (kind === 'claude') return new ClaudePtyAdapter();
  throw new CrossweaveError(
    'UNKNOWN_AGENT',
    `Unsupported agent kind: ${kind}. M0 supports: claude`,
  );
}
