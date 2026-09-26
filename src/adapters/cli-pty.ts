import type { EnforcementTier } from '../db/repositories/session.js';
import { planSandbox } from '../isolation/sandbox.js';
import { resumeArgv, type AgentProfile } from './catalog.js';
import { spawnInPty } from './pty.js';
import type { AgentAdapter, AgentProcess, SpawnOptions } from './types.js';

/**
 * Any interactive agent CLI (Codex, OpenCode, Gemini, Antigravity, a user-declared
 * command) run in a pty — the same process shape as a terminal pane.
 *
 * T3, always: crossweave has no hook into these CLIs, so it can report a collision
 * after the fact but never stop a write, and the tier says exactly that.
 */
export class CliPtyAdapter implements AgentAdapter {
  readonly enforcementTier: EnforcementTier = 'T3';

  constructor(
    readonly kind: string,
    /** The configured launch argv, from Settings. */
    readonly argv: string[],
    private readonly profile: AgentProfile,
  ) {}

  spawn(opts: SpawnOptions): AgentProcess {
    const base = [...this.argv, ...(opts.extraArgs ?? [])];
    const argv = opts.resumeId !== undefined && this.profile.resume !== undefined
      ? resumeArgv(this.profile.resume, base, opts.resumeId)
      : base;
    const [command, ...args] = argv as [string, ...string[]];
    const plan = opts.sandbox === undefined ? undefined : planSandbox(opts.sandbox, command, args);
    return spawnInPty(plan?.argv ?? argv, opts, plan?.cleanup);
  }
}
