import { describe, expect, test } from 'bun:test';
import { SetupExitWatcher } from '../../src/daemon/setup-exit-watcher.js';

const SENTINEL = (code: number): string => `\u001b]6961;${code}\u0007`;

describe('SetupExitWatcher', () => {
  test('calls back with the exit code once the sentinel completes', () => {
    const seen: Array<[string, number]> = [];
    const watcher = new SetupExitWatcher((id, code) => seen.push([id, code]));
    watcher.started('s_1');
    watcher.output('s_1', `installing...\n${SENTINEL(0)}$ `);
    expect(seen).toEqual([['s_1', 0]]);
  });

  test('a sentinel split across chunks is still recognized', () => {
    const seen: Array<[string, number]> = [];
    const watcher = new SetupExitWatcher((id, code) => seen.push([id, code]));
    watcher.started('s_1');
    watcher.output('s_1', 'building\u001b]6961;1');
    expect(seen).toEqual([]);
    watcher.output('s_1', '\u0007prompt$ ');
    expect(seen).toEqual([['s_1', 1]]);
  });

  test('ordinary output containing no sentinel never fires, and does not leak memory unbounded', () => {
    const seen: Array<[string, number]> = [];
    const watcher = new SetupExitWatcher((id, code) => seen.push([id, code]));
    watcher.started('s_1');
    for (let i = 0; i < 200; i += 1) watcher.output('s_1', `line ${i}\n`);
    expect(seen).toEqual([]);
  });

  test('sessions are independent: one session\'s sentinel does not fire for another', () => {
    const seen: Array<[string, number]> = [];
    const watcher = new SetupExitWatcher((id, code) => seen.push([id, code]));
    watcher.started('s_1');
    watcher.started('s_2');
    watcher.output('s_1', 'partial\u001b]6961;9');
    watcher.output('s_2', `full${SENTINEL(0)}`);
    expect(seen).toEqual([['s_2', 0]]);
  });

  test('started() and exited() clear any pending partial buffer for that session', () => {
    const seen: Array<[string, number]> = [];
    const watcher = new SetupExitWatcher((id, code) => seen.push([id, code]));
    watcher.started('s_1');
    watcher.output('s_1', 'partial\u001b]6961;9'); // never completes
    watcher.exited('s_1', 0, false);
    watcher.started('s_1'); // a fresh session start — the old partial must not leak in
    watcher.output('s_1', '\u0007 rest of a totally different line');
    expect(seen).toEqual([]);
  });

  test('fires only once per completed sentinel, even if output keeps flowing after it', () => {
    const seen: Array<[string, number]> = [];
    const watcher = new SetupExitWatcher((id, code) => seen.push([id, code]));
    watcher.started('s_1');
    watcher.output('s_1', SENTINEL(0));
    watcher.output('s_1', 'more output after setup finished\n');
    expect(seen).toEqual([['s_1', 0]]);
  });
});
