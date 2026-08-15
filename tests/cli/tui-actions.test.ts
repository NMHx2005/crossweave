import { describe, expect, test } from 'bun:test';
import { confirmWithLayerPaused, landAllInOrder, resolveSelfInvocation } from '../../src/cli/commands/tui.js';

describe('landAllInOrder', () => {
  test('lands each name in order, stopping at the first failure', async () => {
    const attempted: string[] = [];
    const land = async (name: string) => {
      attempted.push(name);
      if (name === 'bob') throw new Error('conflict');
    };
    const results = await landAllInOrder(['alice', 'bob', 'carol'], land);
    expect(attempted).toEqual(['alice', 'bob']); // carol never attempted
    expect(results.landed).toEqual(['alice']);
    expect(results.failedAt).toBe('bob');
  });

  test('all succeed when nothing fails', async () => {
    const attempted: string[] = [];
    const land = async (name: string) => { attempted.push(name); };
    const results = await landAllInOrder(['alice', 'bob'], land);
    expect(attempted).toEqual(['alice', 'bob']);
    expect(results.landed).toEqual(['alice', 'bob']);
    expect(results.failedAt).toBeUndefined();
  });
});

describe('confirmWithLayerPaused', () => {
  // Regression guard for the keymap-vs-confirm race (see tui.ts's own doc
  // comment on confirmDestructive): a real @opentui/keymap + terminal is
  // needed to prove the underlying race itself stays closed, but this at
  // least locks in the call order a future refactor could silently break.
  test('unregisters before waiting, registers after a "y" answer, resolves true', async () => {
    const calls: string[] = [];
    const unregister = () => calls.push('unregister');
    const register = () => calls.push('register');
    const waitForKey = async () => {
      calls.push('wait');
      return { name: 'y' };
    };
    const confirmed = await confirmWithLayerPaused(unregister, register, waitForKey);
    expect(confirmed).toBe(true);
    expect(calls).toEqual(['unregister', 'wait', 'register']);
  });

  test('still registers again on a non-"y" answer, resolves false', async () => {
    const calls: string[] = [];
    const unregister = () => calls.push('unregister');
    const register = () => calls.push('register');
    const waitForKey = async () => {
      calls.push('wait');
      return { name: 'k' };
    };
    const confirmed = await confirmWithLayerPaused(unregister, register, waitForKey);
    expect(confirmed).toBe(false);
    expect(calls).toEqual(['unregister', 'wait', 'register']);
  });

  test('still registers again even if waitForKey rejects', async () => {
    const calls: string[] = [];
    const unregister = () => calls.push('unregister');
    const register = () => calls.push('register');
    const waitForKey = async () => {
      throw new Error('boom');
    };
    await expect(confirmWithLayerPaused(unregister, register, waitForKey)).rejects.toThrow('boom');
    expect(calls).toEqual(['unregister', 'register']);
  });
});

describe('resolveSelfInvocation', () => {
  // Real captured values (see task-8-report.md) — not fabricated shapes.
  test('source mode: [execPath, argv[1]] — the bun runtime plus the real script path', () => {
    const argv = ['/opt/homebrew/Cellar/bun/1.3.14/bin/bun', '/repo/src/cli/index.ts', 'tui'];
    const execPath = '/opt/homebrew/Cellar/bun/1.3.14/bin/bun';
    expect(resolveSelfInvocation(argv, execPath)).toEqual([execPath, '/repo/src/cli/index.ts']);
  });

  test('compiled mode: [execPath] alone — argv[1] is the unusable /$bunfs/ virtual path', () => {
    const argv = ['bun', '/$bunfs/root/cw', 'tui'];
    const execPath = '/repo/dist/cw';
    expect(resolveSelfInvocation(argv, execPath)).toEqual([execPath]);
  });
});
