/**
 * Must be the first import of the CLI entry, before citty.
 *
 * citty decides whether to colour its usage output once, when its module is
 * evaluated, from the environment alone (`NO_COLOR`/`TERM=dumb`/`CI`) — never from
 * whether stdout is a terminal. `cw | less`, `cw > file` and every test that pipes
 * stdout therefore got raw escape codes. Setting NO_COLOR for that one evaluation,
 * then restoring it, keeps the flag out of the environment the daemon and agents
 * inherit (an agent's own terminal colour is not ours to switch off).
 */
const previous = process.env.NO_COLOR;
if (!process.stdout.isTTY) process.env.NO_COLOR = '1';

export function restoreColorEnv(): void {
  if (previous === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = previous;
}
