import { planSandbox, type SandboxSpec } from '../isolation/sandbox.js';
import { spawnInPty } from './pty.js';
import type { AgentProcess } from './types.js';

/**
 * A login shell in a pty — the Terminal pane's process. Wrapped in `sandbox` when
 * given, exactly as a session's agent is: a shell next to a sandboxed agent must not
 * be the way around its boundary.
 */
export function spawnShell(opts: {
  shell: string;
  cwd: string;
  env: Record<string, string>;
  sandbox?: SandboxSpec;
}): AgentProcess {
  const args = ['-l'];
  const plan = opts.sandbox === undefined ? undefined : planSandbox(opts.sandbox, opts.shell, args);
  return spawnInPty(plan?.argv ?? [opts.shell, ...args], { cwd: opts.cwd, env: opts.env, cols: 80, rows: 24 }, plan?.cleanup);
}
