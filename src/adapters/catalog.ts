import { CrossweaveError } from '../core/errors.js';
import { splitCommand, type AgentDef, type UserSettings } from '../core/settings.js';
import type { EnforcementTier } from '../db/repositories/session.js';

/** How an agent reopens a previous conversation, if it can at all. */
export type ResumeKind = 'claude' | 'codex' | 'opencode';

/**
 * What crossweave knows about a built-in agent beyond its launch command — none of it
 * is user-editable, because none of it is a preference.
 *
 * - `tier`: only Claude Code has a hook crossweave can block through (T2); every
 *   other CLI's writes are unintercepted, so it is advisory (T3) and must say so.
 * - `statePaths`: home-relative dirs/files the agent writes its own state to; the OS
 *   sandbox opens exactly these (an agent that cannot write its config or session
 *   log breaks on start).
 */
export interface AgentProfile {
  tier: EnforcementTier;
  statePaths: string[];
  resume?: ResumeKind;
}

const PROFILES: Record<string, AgentProfile> = {
  claude: { tier: 'T2', statePaths: ['.claude', '.claude.json'], resume: 'claude' },
  codex: { tier: 'T3', statePaths: ['.codex'], resume: 'codex' },
  opencode: {
    tier: 'T3',
    statePaths: ['.local/share/opencode', '.local/state/opencode', '.config/opencode', '.cache/opencode'],
    resume: 'opencode',
  },
  gemini: { tier: 'T3', statePaths: ['.gemini'] },
  // Cursor's adapters are not catalog entries (they need daemon internals), but their
  // CLI still writes ~/.cursor — which the sandbox used to deny, opening Claude's dirs.
  cursor: { tier: 'T1', statePaths: ['.cursor'] },
  'cursor-print': { tier: 'T3', statePaths: ['.cursor'] },
  antigravity: { tier: 'T3', statePaths: ['.gemini', '.antigravity'] },
};

/** A user-declared agent: advisory, no state paths, relaunched rather than resumed. */
const CUSTOM: AgentProfile = { tier: 'T3', statePaths: [] };

export function profileFor(agentId: string): AgentProfile {
  return PROFILES[agentId] ?? CUSTOM;
}

/** The enabled catalog entry for `agentId`, with its argv. */
export function resolveAgent(agentId: string, settings: UserSettings): { def: AgentDef; argv: string[]; profile: AgentProfile } {
  const def = settings.agents.find((a) => a.id === agentId);
  if (def === undefined) {
    const known = ['cursor', 'cursor-print', ...settings.agents.map((a) => a.id)];
    throw new CrossweaveError('UNKNOWN_AGENT', `Unsupported agent kind: ${agentId}. Supports: ${known.join(', ')}`);
  }
  if (!def.enabled) {
    throw new CrossweaveError('AGENT_DISABLED', `Agent ${def.label} is turned off in Settings`);
  }
  return { def, argv: splitCommand(def.command), profile: profileFor(agentId) };
}

/** `argv` reopening conversation `id`, in each agent's own form. */
export function resumeArgv(kind: ResumeKind, argv: string[], id: string): string[] {
  const [command, ...rest] = argv as [string, ...string[]];
  if (kind === 'claude') return [command, ...rest, '--resume', id];
  // `codex resume <id>` is a subcommand: it has to precede the other arguments.
  if (kind === 'codex') return [command, 'resume', id, ...rest];
  return [command, ...rest, '--session', id];
}
