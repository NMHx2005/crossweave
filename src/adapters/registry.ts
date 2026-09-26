import { spawnShell } from './shell.js';
import type { AgentAdapter } from './types.js';

/** The kind every session has: a worktree and the user's shell in it. */
export const SHELL_KIND = 'shell';

/**
 * A session's process is the user's login shell in its worktree; whatever they run
 * there (`claude …`, a `cx` wrapper, `codex …`) is theirs to type. crossweave no
 * longer picks, configures or launches agents.
 */
export function createAdapter(shell: string = process.env.SHELL ?? '/bin/sh'): AgentAdapter {
  return {
    kind: SHELL_KIND,
    enforcementTier: 'T3',
    spawn: (opts) => spawnShell({ shell, cwd: opts.cwd, env: opts.env, cols: opts.cols, rows: opts.rows }),
  };
}
