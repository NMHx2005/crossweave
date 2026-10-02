import { describe, expect, it } from 'bun:test';
import { collectBrowserErrors } from '../../src/core/browser-agent/errors.js';
import type { ConsoleEntry, NetworkEntry } from '../../src/core/browser-agent/capture.js';

/**
 * What the Debug pane shows from a project's readable browser panes: the page's own
 * console errors and failed requests, one line each, bounded and ordered.
 */

const con = (t: number, level: ConsoleEntry['level'], text: string): ConsoleEntry => ({ t, level, text });
const net = (t: number, over: Partial<NetworkEntry> = {}): NetworkEntry => ({ t, method: 'GET', url: '/api', status: 500, type: 'XHR', ms: 12, bytes: 3, failed: false, ...over });

describe('collectBrowserErrors', () => {
  it('takes console errors and failed requests together, tagged by source, oldest first', () => {
    const rows = collectBrowserErrors([
      { paneId: 'p1', console: [con(3, 'error', 'boom'), con(2, 'warn', 'ignored')], network: [net(1, { failed: true, error: 'ECONNREFUSED' }), net(4, { status: 500 })] },
    ]);
    expect(rows.map((r) => [r.source, r.text])).toEqual([
      ['network', 'GET /api — ECONNREFUSED'],
      ['console', 'boom'],
      ['network', 'GET /api'],
    ]);
    expect(rows.map((r) => r.paneId)).toEqual(['p1', 'p1', 'p1']);
  });

  it('a pane with nothing readable contributes nothing', () => {
    expect(collectBrowserErrors([{ paneId: 'p1', console: [], network: [] }])).toEqual([]);
  });

  it('holds a per-pane and a total budget', () => {
    const many = Array.from({ length: 40 }, (_, i) => con(i, 'error', `e${i}`));
    const rows = collectBrowserErrors([{ paneId: 'p', console: many, network: [] }], { limitEach: 5, maxRows: 3 });
    expect(rows).toHaveLength(3);
    // Newest kept, twice: the last five of forty, then the last three of those.
    expect(rows.map((r) => r.text)).toEqual(['e37', 'e38', 'e39']);
  });

  it('several panes are merged in time order', () => {
    const rows = collectBrowserErrors([
      { paneId: 'a', console: [con(5, 'error', 'late')], network: [] },
      { paneId: 'b', console: [con(1, 'error', 'early')], network: [] },
    ]);
    expect(rows.map((r) => `${r.paneId}:${r.text}`)).toEqual(['b:early', 'a:late']);
  });
});
