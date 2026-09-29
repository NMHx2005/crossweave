export type AccessLevel = 'off' | 'read' | 'control';

export const BROWSER_COMMANDS = ['list', 'console', 'network', 'dom', 'shot', 'navigate', 'click', 'type', 'eval'] as const;
export type BrowserCommand = (typeof BROWSER_COMMANDS)[number];

const READS: ReadonlySet<BrowserCommand> = new Set(['console', 'network', 'dom', 'shot']);

export type Decision = { ok: true; confirm: boolean } | { ok: false; code: 'BROWSER_PANE_OFF'; message: string };

/**
 * What a pane's access level allows for one command, and whether the person must confirm it.
 * `localOrigin` is about the page's CURRENT origin, read at execution time by the caller. `eval`
 * asks everywhere: arbitrary script is a wider grant than a click, so being local does not excuse it.
 */
export function decide(command: BrowserCommand, level: AccessLevel, localOrigin: boolean): Decision {
  if (command === 'list') return { ok: true, confirm: false };
  const isRead = READS.has(command);
  if (level === 'off') return { ok: false, code: 'BROWSER_PANE_OFF', message: 'This browser pane is off: switch it to read or control in the pane' };
  if (!isRead && level !== 'control') return { ok: false, code: 'BROWSER_PANE_OFF', message: `${command} needs this browser pane set to control (it is read)` };
  if (isRead) return { ok: true, confirm: false };
  return { ok: true, confirm: command === 'eval' || !localOrigin };
}
