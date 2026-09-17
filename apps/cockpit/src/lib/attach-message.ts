/**
 * What a pane says when it could not attach to its session.
 *
 * The raw failure that reaches the renderer is an Electron IPC wrapper around a
 * CrossweaveError — `Error invoking remote method 'session.attach': CrossweaveError:
 * Session is not running: alice` — which was being written into the terminal verbatim.
 * That leaks the transport (which channel, which error class) into the agent's own
 * output pane, and it says nothing about what to do next.
 *
 * This is presentation only: the error codes stay untouched everywhere else.
 */

/** The transport's two wrappers, in the order the renderer receives them. */
const IPC_PREFIX = /^Error invoking remote method '[^']*':\s*/
const ERROR_CLASS_PREFIX = /^(?:CrossweaveError|Error):\s*/

/** `Session is not running: <name>` — the one failure a user can actually act on. */
const NOT_RUNNING = /Session is not running(?::\s*(.+))?$/

export function describeAttachFailure(message: string): string {
  const unwrapped = message.replace(IPC_PREFIX, '').replace(ERROR_CLASS_PREFIX, '').trim()
  const notRunning = NOT_RUNNING.exec(unwrapped)
  if (notRunning !== null) {
    const name = notRunning[1]?.trim()
    const subject = name !== undefined && name.length > 0 ? `${name} is not running` : 'This session is not running'
    // `cw session start` is the CLI's verb for exactly this state; the rail's own
    // Start button appears for the same reason, one pane away.
    return `${subject} — start it (Start in the rail, or cw session start ${name ?? '<name>'}) to attach.`
  }
  return unwrapped
}
