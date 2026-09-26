import { spawnInPty } from './pty.js';
import type { AgentProcess } from './types.js';

/**
 * A login shell in a pty: a session's own process, and every extra Terminal pane.
 * Never sandboxed — it is the user typing, and run inside a boundary their own
 * dotfiles broke (oh-my-zsh, fnm and zsh history could not write under ~).
 */
export function spawnShell(opts: {
  shell: string;
  cwd: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
}): AgentProcess {
  return spawnInPty([opts.shell, '-l'], { cwd: opts.cwd, env: opts.env, cols: opts.cols ?? 80, rows: opts.rows ?? 24 });
}
