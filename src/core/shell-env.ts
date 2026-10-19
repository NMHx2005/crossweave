/**
 * Colour switches that belong to whatever started the daemon, not to the pane.
 *
 * A session shell is a terminal of the user's, and its colours are the user's to see.
 * A cockpit launched from Finder — or from any terminal that exports `NO_COLOR`, as
 * Apple Terminal's profiles can — handed that switch to the daemon, and from there to
 * every session: Claude Code printed its whole transcript grey (0 colour sequences,
 * where a fresh launch prints 80), Codex lost most of its own, and OpenCode ignored it
 * — so the same window had some panes coloured and some not, which is what made it
 * look like a rendering bug rather than an inherited variable.
 *
 * `FORCE_COLOR=0` is the same instruction spelled the other way (chalk reads both);
 * `FORCE_COLOR=1` is not — it asks for colour, and the pane can honour that.
 */
const INHERITED_NO_COLOUR = new Set(['NO_COLOR', 'NODE_DISABLE_COLORS']);

/** True for a `FORCE_COLOR` value that means "off" rather than "on". */
function forceColourOff(value: string): boolean {
  return value === '0' || value === 'false';
}

/**
 * Whether this name/value pair says "the stream I came from has no colour".
 *
 * Exported because there is a second door: `cw session start` forwards its whole
 * environment to the daemon as the session's own (src/cli/commands/session.ts), so
 * the same switch arrives labelled as the user's rather than as inherited. The daemon
 * drops it in `clientEnv` (src/daemon/methods.ts) before a launcher's env is merged.
 */
export function isNoColourSwitch(name: string, value: string): boolean {
  return INHERITED_NO_COLOUR.has(name) || (name === 'FORCE_COLOR' && forceColourOff(value));
}

/**
 * `env` without the colour switches, for a client's forwarding of its own environment.
 * A launcher's env (Settings → Launchers) is applied after this and may set them back:
 * that one is a person naming a session's colour, not a terminal describing itself.
 */
export function withoutNoColourSwitch(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!isNoColourSwitch(name, value)) out[name] = value;
  }
  return out;
}

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
  // Inherited first, and the colour switch dropped here rather than in the shared
  // check below: a launcher the user configured with NO_COLOR (Settings → Launchers)
  // is their decision about that session, so `own` is allowed to put it back.
  for (const [name, value] of Object.entries(inherited)) {
    if (value === undefined || SESSION_IDENTITY.has(name) || isNoColourSwitch(name, value)) continue;
    out[name] = value;
  }
  for (const [name, value] of Object.entries(own)) {
    if (value === undefined || SESSION_IDENTITY.has(name)) continue;
    out[name] = value;
  }
  out.TERM = 'xterm-256color';
  return out;
}
