/**
 * Variables that say "you are running inside an agent's session", as opposed to how
 * the user configured their tools. A session shell is a fresh terminal of the user's,
 * not a child of whatever started the daemon: a daemon launched from inside Claude
 * Code handed that session's identity to every shell, and `claude` run there took
 * itself for a child session (transcript saving off) and saw the parent's messaging
 * socket and token. Named one by one rather than by prefix, so settings the user
 * exports on purpose (CLAUDE_CODE_USE_BEDROCK, ANTHROPIC_MODEL, …) still arrive.
 */
const SESSION_IDENTITY = new Set([
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
  'CLAUDE_TMPDIR',
  'CLAUDE_EFFORT',
]);

/** The environment a session shell starts with: inherited, then the session's own, minus any agent session identity. */
export function shellEnv(
  inherited: Record<string, string | undefined>,
  own: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries({ ...inherited, ...own })) {
    if (value === undefined || SESSION_IDENTITY.has(name)) continue;
    out[name] = value;
  }
  out.TERM = 'xterm-256color';
  return out;
}
