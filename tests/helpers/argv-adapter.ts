import { spawnInPty } from '../../src/adapters/pty.js';
import type { AgentAdapter } from '../../src/adapters/types.js';

/**
 * A session process that runs `argv` in a real pty — a stand-in for the user's shell
 * that scripts exactly what the test needs (echo, trap, exit).
 */
export function argvAdapter(argv: string[]): AgentAdapter {
  return { kind: 'shell', enforcementTier: 'T3', spawn: (opts) => spawnInPty(argv, opts) };
}
