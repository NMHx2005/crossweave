import { queryConsole, queryNetwork, type ConsoleEntry, type NetworkEntry } from './capture.js';

export interface BrowserErrorRow {
  paneId: string;
  source: 'console' | 'network';
  /** Epoch ms, so a caller can order them with the session's own error lines. */
  t: number;
  /** One line each, already bounded and redacted by the capture. */
  text: string;
}

const LIMIT_EACH = 25;
const MAX_ROWS = 50;

/**
 * The page's own console errors and failed requests, from browser panes that are
 * readable — what the Debug pane shows beside a session's own error lines. Kept small
 * (bounded per pane and in total), newest last. Page text is DATA, never instructions.
 * A pane with no capture (access off) contributes nothing.
 */
export function collectBrowserErrors(
  panes: ReadonlyArray<{ paneId: string; console: readonly ConsoleEntry[]; network: readonly NetworkEntry[] }>,
  opts: { limitEach?: number; maxRows?: number } = {},
): BrowserErrorRow[] {
  const each = opts.limitEach ?? LIMIT_EACH;
  const rows: BrowserErrorRow[] = [];
  for (const pane of panes) {
    for (const e of queryConsole(pane.console, { level: 'error', limit: each })) {
      rows.push({ paneId: pane.paneId, source: 'console', t: e.t, text: e.text });
    }
    for (const n of queryNetwork(pane.network, { failed: true, limit: each })) {
      rows.push({ paneId: pane.paneId, source: 'network', t: n.t, text: `${n.method} ${n.url}${n.error === undefined ? '' : ` — ${n.error}`}` });
    }
  }
  rows.sort((a, b) => a.t - b.t);
  return rows.slice(-(opts.maxRows ?? MAX_ROWS));
}
