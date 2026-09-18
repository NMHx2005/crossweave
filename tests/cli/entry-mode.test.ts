import { describe, it, expect } from 'bun:test';
import { shouldOpenApp } from '../../src/cli/entry-mode.js';

// Matches the real shape: `process.argv` is [runtime, entry, ...args], so a bare
// invocation is length 2 — not length 1, which is why the predicate tests length.
const argv = (...rest: string[]): string[] => ['/path/to/bun', '/path/to/cw.ts', ...rest];

describe('shouldOpenApp', () => {
  it('opens the app for a bare invocation on a terminal', () => {
    expect(shouldOpenApp(argv(), true)).toBe(true);
  });

  // The load-bearing case: a pipe is not a terminal, and a full-screen renderer
  // written into one is garbage in someone's log rather than an app.
  it('does not open the app when there is no terminal, so pipes get help', () => {
    expect(shouldOpenApp(argv(), false)).toBe(false);
  });

  it('never re-routes an explicit subcommand or flag', () => {
    for (const args of [['tui'], ['-h'], ['--help'], ['-v'], ['--version'], ['session', 'list']]) {
      expect(shouldOpenApp(argv(...args), true)).toBe(false);
    }
  });

  it('is not fooled by a flag that happens to be the only argument', () => {
    expect(shouldOpenApp(argv('-h'), true)).toBe(false);
  });
});
