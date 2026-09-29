import { describe, expect, it } from 'bun:test';
import { buildPaneRequest, formatPaneList, PANE_CONFIRM_TIMEOUT_MS } from '../../src/cli/commands/pane.js';

const build = (sub: string, positionals: string[] = [], flags: Record<string, string | undefined> = {}) => buildPaneRequest(sub, positionals, flags);
const codeOf = (fn: () => unknown): string => { try { fn(); return 'ok'; } catch (e) { return (e as { code?: string }).code ?? 'no-code'; } };

describe('buildPaneRequest', () => {
  it('list', () => {
    expect(build('list')).toEqual({ kind: 'pane.list', params: {}, timeoutMs: 10_000 });
  });

  it('split: right by default, down on request, a pane by --pane', () => {
    expect(build('split')).toMatchObject({ kind: 'pane.split', params: { direction: 'right' } });
    expect(build('split', ['down'])).toMatchObject({ params: { direction: 'down' } });
    expect(build('split', ['right'], { pane: 'p_1' })).toMatchObject({ params: { direction: 'right', paneId: 'p_1' } });
    expect(codeOf(() => build('split', ['sideways']))).toBe('INVALID_ARGUMENTS');
  });

  it('select: a direction or a pane id, exactly one', () => {
    expect(build('select', ['left'])).toMatchObject({ kind: 'pane.select', params: { direction: 'left' } });
    expect(build('select', ['p_9'])).toMatchObject({ params: { paneId: 'p_9' } });
    expect(codeOf(() => build('select'))).toBe('INVALID_ARGUMENTS');
  });

  it('zoom, layout and move', () => {
    expect(build('zoom')).toMatchObject({ kind: 'pane.zoom', params: {} });
    expect(build('zoom', ['p_2'])).toMatchObject({ params: { paneId: 'p_2' } });
    expect(build('layout', ['tiled'])).toMatchObject({ kind: 'pane.layout', params: { preset: 'tiled' } });
    expect(codeOf(() => build('layout'))).toBe('INVALID_ARGUMENTS');
    expect(build('move', ['p_1', '2'])).toMatchObject({ kind: 'pane.move', params: { paneId: 'p_1', tab: 2 } });
    expect(build('move', ['p_1', 't_abc'])).toMatchObject({ params: { paneId: 'p_1', tab: 't_abc' } });
    expect(codeOf(() => build('move', ['p_1']))).toBe('INVALID_ARGUMENTS');
  });

  it('sync defaults to a toggle and takes on|off', () => {
    expect(build('sync')).toMatchObject({ kind: 'pane.sync', params: { mode: 'toggle' } });
    expect(build('sync', ['on'])).toMatchObject({ params: { mode: 'on' } });
    expect(codeOf(() => build('sync', ['maybe']))).toBe('INVALID_ARGUMENTS');
  });

  // The kinds that ask the person get a timeout longer than the cockpit's own confirmation (45 s).
  it('close, sync-on and open wait long enough for a person to answer; the rest do not', () => {
    expect(PANE_CONFIRM_TIMEOUT_MS).toBeGreaterThan(45_000);
    expect(build('close')).toMatchObject({ kind: 'pane.close', timeoutMs: PANE_CONFIRM_TIMEOUT_MS });
    expect(build('sync', ['on'])).toMatchObject({ timeoutMs: PANE_CONFIRM_TIMEOUT_MS });
    expect(build('open', [], { url: 'http://localhost:3000' })).toMatchObject({ kind: 'pane.openUrl', params: { url: 'http://localhost:3000' }, timeoutMs: PANE_CONFIRM_TIMEOUT_MS });
    expect(build('split').timeoutMs).toBeLessThan(45_000);
    expect(build('select', ['left']).timeoutMs).toBeLessThan(45_000);
  });

  it('open: exactly one of --url and --file; a file needs its --session', () => {
    expect(build('open', [], { file: 'src/a.ts', session: 'alpha' })).toMatchObject({ kind: 'pane.openFile', params: { session: 'alpha', path: 'src/a.ts' } });
    expect(codeOf(() => build('open'))).toBe('INVALID_ARGUMENTS');
    expect(codeOf(() => build('open', [], { url: 'http://x', file: 'a' }))).toBe('INVALID_ARGUMENTS');
    expect(codeOf(() => build('open', [], { file: 'a' }))).toBe('INVALID_ARGUMENTS');
  });

  it('an unknown subcommand is refused here, before anything is sent', () => {
    for (const sub of ['send-keys', 'run', 'kill', '']) expect(codeOf(() => build(sub))).toBe('INVALID_ARGUMENTS');
  });
});

describe('formatPaneList', () => {
  const list = {
    activeTabId: 't_2',
    tabs: [
      { id: 't_1', index: 1, title: 'alpha', active: false, sync: false, zoomedPaneId: null, panes: [{ id: 'p_1', kind: 'session', focused: true, session: 'alpha' }] },
      { id: 't_2', index: 2, title: 'web', active: true, sync: true, zoomedPaneId: 'p_3', panes: [
        { id: 'p_3', kind: 'browser', focused: true, url: 'http://localhost:3000' },
        { id: 'p_4', kind: 'file', focused: false, session: 'beta', path: 'src/a.ts' },
      ] },
    ],
  };

  it('one line per tab and per pane, marking the active tab and the focused pane', () => {
    const out = formatPaneList(list).split('\n');
    expect(out[0]).toBe('TAB 1\tt_1\talpha');
    expect(out[1]).toBe('  PANE\tp_1\tsession\talpha\t*');
    expect(out[2]).toBe('TAB 2\tt_2\tweb\t*active\tsync');
    expect(out[3]).toBe('  PANE\tp_3\tbrowser\thttp://localhost:3000\t*');
    expect(out[4]).toBe('  PANE\tp_4\tfile\tbeta:src/a.ts');
  });

  it('nothing open', () => {
    expect(formatPaneList({ activeTabId: null, tabs: [] })).toBe('no tabs');
  });
});
