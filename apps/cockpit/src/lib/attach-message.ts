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

/** `Session is not running: <name>`: the pane's own "shell is closed" bar says so. */
const NOT_RUNNING = /Session is not running(?::\s*(.+))?$/

/** The sentence to write into the pane, or '' when there is nothing to add. */
export function describeAttachFailure(message: string): string {
  const unwrapped = message.replace(IPC_PREFIX, '').replace(ERROR_CLASS_PREFIX, '').trim()
  // The bar docked under a stopped session's pane already says its shell is closed
  // and opens a new one; a second notice inside the terminal only repeated it.
  if (NOT_RUNNING.test(unwrapped)) return ''
  return unwrapped
}
