/**
 * Terminal REPORTS — what a terminal sends back on its own in answer to a query, as
 * opposed to anything a person typed: device attributes (`CSI ? … c`, `CSI > … c`),
 * focus in/out (`CSI I`, `CSI O`), cursor position (`CSI row;col R`) and OSC colour
 * replies (`OSC 10/11/… ; … ST|BEL`).
 *
 * Replaying a session's scrollback into a terminal re-runs the queries the agent
 * made when it started. The terminal answers them again, long after the agent
 * stopped waiting, and forwarding those answers typed `^[[?1;2c` into Claude Code's
 * prompt. Callers drop these only while a replay is being answered, so a live
 * agent's own queries still get their replies.
 */
const REPORT = /\x1b\[[?>][\d;]*c|\x1b\[[IO]|\x1b\[\d+;\d+R|\x1b\]1[0-9];[^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripTerminalReports(data: string): string {
  return data.replace(REPORT, '');
}

/**
 * Focus in/out reports (`CSI I`, `CSI O`), which an agent asks for with `CSI ?1004h`.
 * The cockpit drops them for good: its panes gain and lose focus on every click
 * between them, and Claude Code's trust prompt printed them as `^[[O^[[I` text.
 */
export function stripFocusReports(data: string): string {
  return data.replace(/\x1b\[[IO]/g, '');
}
