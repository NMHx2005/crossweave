import { defineCommand, type ArgsDef } from 'citty';
import { CrossweaveError } from '../../core/errors.js';
import { bridgeCall } from '../bridge-call.js';
import { currentWorkspaceId, fail, withClient } from '../context.js';

/**
 * Longer than the cockpit's own confirmation (it refuses after 45 s), so the refusal or the answer
 * always reaches this command rather than a bare timeout.
 */
export const PANE_CONFIRM_TIMEOUT_MS = 60_000;
const QUICK_TIMEOUT_MS = 10_000;

export interface PaneRequest {
  kind: string;
  params: Record<string, unknown>;
  timeoutMs: number;
}

const bad = (message: string): CrossweaveError => new CrossweaveError('INVALID_ARGUMENTS', message);
const DIRECTIONS = ['left', 'right', 'up', 'down'];
const PRESETS = ['even-horizontal', 'even-vertical', 'main-left', 'tiled'];

/**
 * The bridge request a `cw pane <sub> …` line stands for. Only the fixed set of subcommands maps to a
 * kind: there is no way to name another one from here, and nothing that types into a pane. (The
 * cockpit validates everything again and asks the person where it must: this is only the friendly
 * front door.)
 */
export function buildPaneRequest(sub: string, positionals: readonly string[], flags: Readonly<Record<string, string | undefined>>): PaneRequest {
  const [first, second] = positionals;
  const quick = (kind: string, params: Record<string, unknown> = {}): PaneRequest => ({ kind, params, timeoutMs: QUICK_TIMEOUT_MS });
  const asks = (kind: string, params: Record<string, unknown> = {}): PaneRequest => ({ kind, params, timeoutMs: PANE_CONFIRM_TIMEOUT_MS });
  switch (sub) {
    case 'list': return quick('pane.list');
    case 'split': {
      const direction = first ?? 'right';
      if (direction !== 'right' && direction !== 'down') throw bad('split takes right or down');
      return quick('pane.split', { direction, ...(flags.pane === undefined ? {} : { paneId: flags.pane }) });
    }
    case 'select': {
      if (first === undefined) throw bad('select takes a direction (left, right, up, down) or a pane id');
      return quick('pane.select', DIRECTIONS.includes(first) ? { direction: first } : { paneId: first });
    }
    case 'zoom': return quick('pane.zoom', first === undefined ? {} : { paneId: first });
    case 'layout': {
      if (first === undefined || !PRESETS.includes(first)) throw bad(`layout takes one of: ${PRESETS.join(', ')}`);
      return quick('pane.layout', { preset: first });
    }
    case 'move': {
      if (first === undefined || second === undefined) throw bad('move takes a pane id and a tab (a number from 1, or a tab id)');
      return quick('pane.move', { paneId: first, tab: /^\d+$/.test(second) ? Number(second) : second });
    }
    case 'sync': {
      const mode = first ?? 'toggle';
      if (mode !== 'on' && mode !== 'off' && mode !== 'toggle') throw bad('sync takes on, off or nothing (toggle)');
      // Turning it on (or toggling, which may) asks the person; off never does.
      return mode === 'off' ? quick('pane.sync', { mode }) : asks('pane.sync', { mode });
    }
    case 'close': return asks('pane.close', first === undefined ? {} : { paneId: first });
    case 'open': {
      if ((flags.url === undefined) === (flags.file === undefined)) throw bad('open takes exactly one of --url and --file');
      if (flags.url !== undefined) return asks('pane.openUrl', { url: flags.url });
      if (flags.session === undefined) throw bad('open --file needs --session (the session the path is inside)');
      return asks('pane.openFile', { session: flags.session, path: flags.file });
    }
    default:
      throw bad(`Unknown pane command: ${sub}`);
  }
}

interface PaneListing {
  activeTabId: string | null;
  tabs: Array<{
    id: string; index: number; title: string; active: boolean; sync: boolean; zoomedPaneId: string | null;
    panes: Array<{ id: string; kind: string; focused: boolean; session?: string | null; url?: string; path?: string }>;
  }>;
}

/** One line per tab and pane, tab-separated, so a script can read it. */
export function formatPaneList(list: PaneListing): string {
  if (list.tabs.length === 0) return 'no tabs';
  const lines: string[] = [];
  for (const tab of list.tabs) {
    lines.push(['TAB ' + tab.index, tab.id, tab.title, ...(tab.active ? ['*active'] : []), ...(tab.sync ? ['sync'] : [])].join('\t'));
    for (const p of tab.panes) {
      const what = p.kind === 'browser' ? p.url ?? '' : p.kind === 'file' ? `${p.session ?? ''}:${p.path ?? ''}` : p.session ?? '';
      lines.push(['  PANE', p.id, p.kind, what, ...(p.focused ? ['*'] : [])].filter((x, i) => i < 4 || x !== '').join('\t'));
    }
  }
  return lines.join('\n');
}

function sub(name: string, description: string, args: ArgsDef) {
  return defineCommand({
    meta: { name, description },
    args,
    async run({ args: given }) {
      try {
        const a = given as unknown as Record<string, string | boolean | undefined>;
        const positionals = [a['first'], a['second']].filter((v): v is string => typeof v === 'string');
        const flags: Record<string, string | undefined> = {};
        for (const k of ['pane', 'url', 'file', 'session']) if (typeof a[k] === 'string') flags[k] = a[k] as string;
        const req = buildPaneRequest(name, positionals, flags);
        await withClient(async (client) => {
          const workspaceId = await currentWorkspaceId(client);
          const result = await bridgeCall(client, workspaceId, req.kind, req.params, req.timeoutMs);
          if (name === 'list') {
            process.stdout.write(`${a['json'] === true ? JSON.stringify(result) : formatPaneList(result as PaneListing)}\n`);
          } else if (a['json'] === true) {
            process.stdout.write(`${JSON.stringify(result)}\n`);
          }
        });
      } catch (err) { fail(err); }
    },
  });
}

const first = { type: 'positional' as const, description: '', required: false };
const json = { type: 'boolean' as const, description: 'Machine-readable output' };

export const paneCommand = defineCommand({
  meta: {
    name: 'pane',
    description: 'Arrange the panes of the running cockpit window (it asks you before it closes a pane, synchronizes, or opens a page or file)',
  },
  subCommands: {
    list: sub('list', 'Tabs and panes, with the ids the other commands take', { json }),
    split: sub('split', 'Open a shell beside a pane: right (default) or down', { first: { ...first, description: 'right | down' }, pane: { type: 'string', description: 'Pane id (default: the focused one)' } }),
    select: sub('select', 'Move focus: left, right, up, down, or a pane id', { first: { ...first, description: 'left | right | up | down | <pane id>', required: true } }),
    zoom: sub('zoom', 'Zoom a pane (or unzoom)', { first: { ...first, description: 'Pane id (default: the focused one)' } }),
    layout: sub('layout', 'Arrange the tab: even-horizontal, even-vertical, main-left, tiled', { first: { ...first, description: 'preset', required: true } }),
    move: sub('move', 'Move a pane to another tab', { first: { ...first, description: 'Pane id', required: true }, second: { ...first, description: 'Tab number (from 1) or tab id', required: true } }),
    sync: sub('sync', 'Synchronize typing across the terminal panes of the tab: on, off, or toggle', { first: { ...first, description: 'on | off' } }),
    close: sub('close', 'Close a pane (asks you first)', { first: { ...first, description: 'Pane id (default: the focused one)' } }),
    open: sub('open', 'Open a page (--url) or a session\'s file (--file, --session) in a pane (asks you first)', {
      url: { type: 'string', description: 'An http or https address' },
      file: { type: 'string', description: 'A path inside the session' },
      session: { type: 'string', description: 'The session the file belongs to' },
    }),
  },
});
